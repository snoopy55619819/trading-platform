//! Business days: when one ends, and the files each one keeps.
//!
//! The exchange closes a business day at the venue's roll time (`business_date_roll_utc` in
//! the published listings, 21:00 UTC, after the New York close). A moment belongs to the
//! business date that is current there: 20:59 UTC on the 12th is the 12th, 21:00 is the 13th.
//!
//! Each business day has two files in the data directory:
//!
//! ```text
//! alpha-2026-11-13.105725.snapshot.json   the state when the day began
//! alpha-2026-11-13.105725.journal         every command during the day
//! ```
//!
//! The number is the first journal sequence number of the day, so files sort by it and a
//! journal always continues the numbering of the one before. Starting up loads the newest
//! snapshot and replays only its day's journal. Older files are never read again and can be
//! archived; the gateway itself never deletes anything.

use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use fix_core::UtcMillis;
use serde::{Deserialize, Serialize};

use crate::listings::Listings;
use crate::recovery::ExchangeState;

const DAY_MS: u64 = 86_400_000;
const PREFIX: &str = "alpha-";
const SNAPSHOT: &str = ".snapshot.json";
const JOURNAL: &str = ".journal";
/// The single journal used before business days existed.
const LEGACY_JOURNAL: &str = "alpha.journal";

/// When business days end.
#[derive(Debug, Clone, Copy)]
pub struct DayClock {
    /// Milliseconds after UTC midnight at which the business date changes.
    roll_ms: u64,
    /// For tests and local checks: close a day this often instead of once a day.
    every_ms: Option<u64>,
}

impl DayClock {
    /// The venue's published roll time.
    pub fn published(listings: &Listings) -> DayClock {
        DayClock {
            roll_ms: listings.business_date_roll_ms,
            every_ms: None,
        }
    }

    /// Closes a day every `secs` seconds as well, so a roll can be watched without waiting
    /// until 21:00. Business dates are still the real ones.
    pub fn every(self, secs: u64) -> DayClock {
        DayClock {
            every_ms: Some(secs.max(1) * 1000),
            ..self
        }
    }

    /// The business date current at `now`, `YYYY-MM-DD`.
    pub fn business_date(&self, now: UtcMillis) -> String {
        UtcMillis(now.0 + DAY_MS - self.roll_ms).to_date()
    }

    /// The next moment a day closes, strictly after `now`.
    pub fn next_roll(&self, now: UtcMillis) -> UtcMillis {
        if let Some(every) = self.every_ms {
            return UtcMillis(now.0 + every);
        }
        let today = now.0 - now.0 % DAY_MS + self.roll_ms;
        UtcMillis(if today > now.0 { today } else { today + DAY_MS })
    }
}

/// One business day's pair of files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Day {
    pub business_date: String,
    /// The first journal sequence number of the day: one more than the snapshot's last.
    pub first_seq: u64,
}

impl Day {
    fn name(&self, suffix: &str) -> String {
        format!("{PREFIX}{}.{}{suffix}", self.business_date, self.first_seq)
    }

    /// Reads `alpha-<date>.<seq>.snapshot.json`.
    fn parse_snapshot_name(name: &str) -> Option<Day> {
        let rest = name.strip_prefix(PREFIX)?.strip_suffix(SNAPSHOT)?;
        let (business_date, seq) = rest.rsplit_once('.')?;
        Some(Day {
            business_date: business_date.to_string(),
            first_seq: seq.parse().ok()?,
        })
    }
}

/// What a snapshot file holds.
#[derive(Debug, Serialize, Deserialize)]
struct SnapshotFile {
    business_date: String,
    state: ExchangeState,
}

/// The directory holding every day's snapshot and journal.
pub struct DataDir {
    path: PathBuf,
}

impl DataDir {
    /// Opens (creating if needed) the data directory. Refuses one that still holds the
    /// single journal from before business days: replaying it would mean replaying all of
    /// history, which is exactly what days exist to avoid.
    pub fn open(path: impl Into<PathBuf>) -> Result<DataDir> {
        let path = path.into();
        fs::create_dir_all(&path).with_context(|| format!("creating {}", path.display()))?;
        let legacy = path.join(LEGACY_JOURNAL);
        if legacy.exists() {
            bail!(
                "{} is a journal from before daily snapshots. Delete it to start the exchange \
                 fresh, and reset the broker's databases too (pnpm db:reset), since the orders \
                 they remember will be gone.",
                legacy.display()
            );
        }
        Ok(DataDir { path })
    }

    pub fn journal(&self, day: &Day) -> PathBuf {
        self.path.join(day.name(JOURNAL))
    }

    /// The newest snapshot and the day it starts, if there is one.
    pub fn latest(&self) -> Result<Option<(Day, ExchangeState)>> {
        let mut newest: Option<Day> = None;
        for entry in fs::read_dir(&self.path)? {
            let name = entry?.file_name();
            let Some(day) = name.to_str().and_then(Day::parse_snapshot_name) else {
                continue;
            };
            if newest.as_ref().is_none_or(|n| day.first_seq > n.first_seq) {
                newest = Some(day);
            }
        }
        let Some(day) = newest else {
            return Ok(None);
        };

        let path = self.path.join(day.name(SNAPSHOT));
        let text =
            fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        let file: SnapshotFile = serde_json::from_str(&text)
            .with_context(|| format!("{} is not a valid snapshot", path.display()))?;
        if file.state.journal_seq + 1 != day.first_seq || file.business_date != day.business_date {
            bail!("{} does not match its own name", path.display());
        }
        Ok(Some((day, file.state)))
    }

    /// Writes the snapshot that starts `day`. Written to a temporary file, flushed to disk,
    /// then renamed into place, so a crash leaves either the whole snapshot or none of it.
    pub fn write_snapshot(&self, day: &Day, state: &ExchangeState) -> Result<()> {
        let path = self.path.join(day.name(SNAPSHOT));
        let temporary = self.path.join(format!("{}.tmp", day.name(SNAPSHOT)));
        let file = SnapshotFile {
            business_date: day.business_date.clone(),
            state: state.clone(),
        };
        let mut out = File::create(&temporary)?;
        serde_json::to_writer_pretty(&mut out, &file)?;
        out.write_all(b"\n")?;
        out.sync_all()?;
        fs::rename(&temporary, &path)
            .with_context(|| format!("moving the snapshot into {}", path.display()))?;
        File::open(&self.path)?.sync_all()?; // makes the rename itself durable
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROLL: u64 = 21 * 3_600_000;
    // 2026-11-12 00:00:00 UTC
    const MIDNIGHT: u64 = 1_794_441_600_000;

    fn clock() -> DayClock {
        DayClock {
            roll_ms: ROLL,
            every_ms: None,
        }
    }

    #[test]
    fn the_business_date_changes_at_the_roll_not_at_midnight() {
        assert_eq!(UtcMillis(MIDNIGHT).to_date(), "2026-11-12");
        let date = |ms| clock().business_date(UtcMillis(ms));
        assert_eq!(date(MIDNIGHT), "2026-11-12");
        assert_eq!(date(MIDNIGHT + ROLL - 1), "2026-11-12");
        assert_eq!(date(MIDNIGHT + ROLL), "2026-11-13");
        assert_eq!(date(MIDNIGHT + DAY_MS - 1), "2026-11-13");
    }

    #[test]
    fn the_next_roll_is_always_later() {
        let next = |ms| clock().next_roll(UtcMillis(ms)).0;
        assert_eq!(next(MIDNIGHT), MIDNIGHT + ROLL);
        assert_eq!(next(MIDNIGHT + ROLL - 1), MIDNIGHT + ROLL);
        assert_eq!(next(MIDNIGHT + ROLL), MIDNIGHT + ROLL + DAY_MS);
        assert_eq!(
            clock().every(5).next_roll(UtcMillis(MIDNIGHT)).0,
            MIDNIGHT + 5000
        );
    }

    #[test]
    fn snapshot_names_read_back() {
        let day = Day {
            business_date: "2026-11-13".into(),
            first_seq: 105_725,
        };
        assert_eq!(day.name(SNAPSHOT), "alpha-2026-11-13.105725.snapshot.json");
        assert_eq!(
            Day::parse_snapshot_name(&day.name(SNAPSHOT)),
            Some(day.clone())
        );
        assert_eq!(Day::parse_snapshot_name(&day.name(JOURNAL)), None);
        assert_eq!(
            Day::parse_snapshot_name("alpha-2026-11-13.1.snapshot.json.tmp"),
            None
        );
    }
}
