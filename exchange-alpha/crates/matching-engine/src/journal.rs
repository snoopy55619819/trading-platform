//! The append-only command journal, and the engine wrapper that uses it.
//!
//! The engine keeps its state in memory only. Durability comes from writing every command to
//! this file **before** applying it, and recovery is replaying the file into a fresh engine.
//! Because the engine is deterministic, replay rebuilds exactly the state that was lost,
//! down to the order ids.
//!
//! Format: one JSON object per line, `{"seq":N,"command":{...}}`, with `seq` counting up
//! from 1. Human-readable on purpose, so a journal can be inspected with `cat`.
//!
//! Durability: each append is flushed to the operating system, which survives the process
//! crashing but not the machine losing power. Surviving power loss means an fsync per write,
//! which costs far more than matching does; the usual answer is to fsync batches ("group
//! commit"). That is a gateway-era decision, so for now this only flushes.

use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::command::Command;
use crate::engine::Engine;
use crate::event::Event;

#[derive(Serialize)]
struct EntryOut<'a> {
    seq: u64,
    command: &'a Command,
}

#[derive(Deserialize)]
struct EntryIn {
    seq: u64,
    command: Command,
}

pub struct Journal {
    writer: BufWriter<File>,
    last_seq: u64,
}

impl Journal {
    /// Opens the journal at `path`, creating it if it does not exist, and returns every
    /// command already in it, oldest first.
    ///
    /// A crash in the middle of an append can leave a final line with no newline. That
    /// command was never applied, because we only apply after the write completes, so the
    /// torn line is dropped and the file trimmed back to the last complete entry. Anything
    /// else that does not parse, or a gap in the sequence numbers, is corruption: we refuse
    /// to start rather than rebuild a book we cannot trust.
    pub fn open(path: impl AsRef<Path>) -> io::Result<(Journal, Vec<Command>)> {
        Self::open_after(path, 0)
    }

    /// Like [`open`](Self::open), for a journal that continues an earlier one: its first
    /// entry must be `after_seq + 1`. A new day's journal continues the numbering of the day
    /// before, so sequence numbers (and the execution ids built from them) never repeat.
    pub fn open_after(
        path: impl AsRef<Path>,
        after_seq: u64,
    ) -> io::Result<(Journal, Vec<Command>)> {
        let path = path.as_ref();
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(path)?;

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;

        let complete = bytes
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |newline| newline + 1);
        if complete < bytes.len() {
            file.set_len(complete as u64)?;
        }

        let mut commands = Vec::new();
        for (index, line) in bytes[..complete]
            .split(|&b| b == b'\n')
            .filter(|line| !line.is_empty())
            .enumerate()
        {
            let line_number = index + 1;
            let entry: EntryIn = serde_json::from_slice(line).map_err(|error| {
                corrupt(path, format!("line {line_number} does not parse: {error}"))
            })?;
            let expected = after_seq + line_number as u64;
            if entry.seq != expected {
                return Err(corrupt(
                    path,
                    format!("expected seq {expected}, found {}", entry.seq),
                ));
            }
            commands.push(entry.command);
        }

        let journal = Journal {
            writer: BufWriter::new(file),
            last_seq: after_seq + commands.len() as u64,
        };
        Ok((journal, commands))
    }

    /// Writes one command and flushes it. Returns only once the command is on its way to
    /// disk, so the caller may then apply it.
    pub fn append(&mut self, command: &Command) -> io::Result<()> {
        let seq = self.last_seq + 1;
        serde_json::to_writer(&mut self.writer, &EntryOut { seq, command })?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        self.last_seq = seq;
        Ok(())
    }

    /// Sequence number of the last command written.
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }
}

fn corrupt(path: &Path, detail: String) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("journal {} is corrupt: {detail}", path.display()),
    )
}

/// An engine whose every command is journaled before it is applied.
///
/// This is the only place write-before-apply is implemented, so it cannot be forgotten in
/// one code path and remembered in another.
pub struct JournaledEngine {
    engine: Engine,
    journal: Journal,
    recovered: usize,
}

impl JournaledEngine {
    /// Opens the journal and replays it, rebuilding the engine as it was.
    ///
    /// The events replay produces are discarded: they were already published the first time
    /// round. Downstream consumers that missed them catch up from a snapshot (milestone 3).
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        Self::open_observing(path, |_| {})
    }

    /// Like [`open`](Self::open), but shows every event the replay produces to `observe`.
    ///
    /// For callers that keep their own state derived from events (the gateway tracks each
    /// order's fills so it can write execution reports). Replaying the journal through them
    /// rebuilds that state exactly as it was, with no separate store to keep in sync.
    pub fn open_observing(path: impl AsRef<Path>, observe: impl FnMut(&Event)) -> io::Result<Self> {
        Self::resume_observing(path, Engine::default(), 0, observe)
    }

    /// Recovery from a snapshot: starts from `engine` (restored from a snapshot taken after
    /// journal entry `after_seq`) and replays only the journal that follows it.
    pub fn resume_observing(
        path: impl AsRef<Path>,
        mut engine: Engine,
        after_seq: u64,
        mut observe: impl FnMut(&Event),
    ) -> io::Result<Self> {
        let (journal, commands) = Journal::open_after(path, after_seq)?;
        let recovered = commands.len();
        for command in commands {
            for event in engine.apply(command) {
                observe(&event);
            }
        }
        Ok(Self {
            engine,
            journal,
            recovered,
        })
    }

    /// Carries on in a new journal file at `path`, continuing the numbering. For the start of
    /// a business day, once the state up to here is safely in a snapshot. Refuses a file that
    /// already has entries: those would be commands the engine has not applied.
    pub fn continue_in(&mut self, path: impl AsRef<Path>) -> io::Result<()> {
        let path = path.as_ref();
        let (journal, commands) = Journal::open_after(path, self.journal.last_seq())?;
        if !commands.is_empty() {
            return Err(corrupt(
                path,
                "a new day's journal already has entries".into(),
            ));
        }
        self.journal = journal;
        Ok(())
    }

    /// Sequence number of the last command journaled. Deterministic across restarts, so it
    /// can name things that must stay unique (the gateway's execution ids use it).
    pub fn last_seq(&self) -> u64 {
        self.journal.last_seq()
    }

    /// Journals the command, then applies it. If the write fails the command is not applied.
    pub fn submit(&mut self, command: Command) -> io::Result<Vec<Event>> {
        self.journal.append(&command)?;
        Ok(self.engine.apply(command))
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// How many commands were replayed when this was opened.
    pub fn recovered(&self) -> usize {
        self.recovered
    }
}
