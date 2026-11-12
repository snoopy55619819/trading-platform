# ADR 0004: Business days and daily snapshots

**Status:** accepted, 2026-11-12. Built before deployment (PR #26 and the one after it).
Changes the "recovery is replay" convention in `CLAUDE.md` and `docs/DECISIONS.md` §10.

## Context

Alpha Exchange had no end of day. Its state lived in memory, and recovery replayed one
journal file from the very first command. Measured locally at the simulator's default
activity, that was about 7.5 commands a second, so the journal grew by about 100 MB a day.
Three things followed:

1. **Every start got slower, then impossible.** The gateway reads the whole journal into
   memory to replay it. Within two to three weeks a restart (a deploy, a reboot, a crash)
   would need more memory than a 2 GB server has, and the exchange would not come back.
2. **Memory grew while running.** The gateway kept every order it had ever seen, filled and
   cancelled ones included, and every `ClOrdID` ever used.
3. **`Day` orders never expired.** With no close, a day order behaved exactly like `GTC`.

A related growth was outside the journal: the exchange keeps a copy of every FIX message it
sends a session, for resends, and drops them only when that session logs on with reset
sequence numbers. The simulator never logged off, so its copies grew by about 250 MB a day.

## Options

1. **A bigger disk and more memory.** Delays every problem; fixes none.
2. **Wipe the exchange periodically.** Simple, but resting orders vanish and the broker's
   records of them stop matching the exchange.
3. **Close the day and expire every resting order, `GTC` included.** The book starts each
   day empty, so a new journal needs no snapshot, only a few counters. Real precedent exists
   (some venues accept only day orders, and brokers re-send good-till-cancelled orders each
   morning), but `GTC` would stop meaning what it says unless the broker learned to re-send.
4. **Close the day, expire `Day` orders, snapshot the state, start a new journal.** A start
   loads the newest snapshot and replays only that day's journal.

## Decision

Option 4. It fixes the cause, keeps order behaviour unchanged, and is how matching engines,
databases and event-sourced systems generally bound recovery: a checkpoint plus the log
since it.

- **The close is a command.** At the venue's published `business_date_roll_utc` (21:00 UTC)
  the gateway journals `EndOfDay`. The engine expires resting `Day` orders (each owner gets
  an `ExecutionReport` with `ExecType=C`) and then emits `DayClosed`, on which the gateway's
  order tracker forgets the day's finished orders and used `ClOrdID`s. Because the close
  is journaled and the clearing follows an event, not a timer, replay reproduces the close
  exactly. Determinism, which the whole design rests on, is untouched.
- **A snapshot holds what replay would rebuild:** the books with their resting orders and
  id counters, the order tracker, and the feed's sequence numbers. Not the feed's price
  levels: those always equal the engine's, so they are rebuilt from its book rather than
  stored twice.
- **Journals continue each other's numbering.** Execution ids are built from journal
  sequence numbers, so a new day must not start again at 1.
- **One file pair per day,** `alpha-<date>.<first seq>.snapshot.json` and `.journal`, in
  `ALPHA_DATA_DIR`. The snapshot is written to a temporary file, flushed, then renamed, so it
  is either whole or absent.
- **Starting covers every interruption.** Stopped mid-roll (the close is journaled, the next
  snapshot is not written): the start finishes the roll. Down at 21:00: the start closes the
  day. Otherwise: newest snapshot, then its day's journal.
- **The simulator resets its FIX session at the roll,** after cancelling everything it has
  resting, which is also what a real trading firm does each day. The exchange then drops
  the messages it was keeping for it. The broker does not reset: its stored messages are
  few, and it relies on resends to recover a missed fill.

## Consequences

- A restart costs the same on day one and day three hundred: one day's journal at most.
- The proof is a randomised test (`gateway/tests/snapshot.rs`): over random order flow
  with closes, a snapshot plus the next journal gives byte-identical state to replaying
  every journal, and to the exchange that kept running.
- `ClOrdID` uniqueness is now per session and business date, as `DECISIONS.md` §3 always
  said. A finished order's id may be used again the next day; a resting order's may not.
- Old day files are never read again. The gateway never deletes anything; archiving them
  (to S3, on a server) belongs to deployment.
- `ALPHA_DATA_DIR` replaced `ALPHA_JOURNAL`. A data directory holding the old single
  `alpha.journal` is refused with instructions, rather than migrated: the data was
  synthetic and nothing was deployed.
- `ALPHA_ROLL_EVERY_SECS` and `SIM_SESSION_RESET_EVERY_SECS` make rolls frequent, to watch
  them locally.
- market-data's `ticks` still grow (about 13 MB a day). That was judged years away from
  mattering; how to move old ticks rather than delete them is in `docs/BACKLOG.md`.
