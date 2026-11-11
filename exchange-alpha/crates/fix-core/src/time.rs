//! Time as FIX writes it: `UTCTimestamp`, `YYYYMMDD-HH:MM:SS.sss`, always UTC.
//!
//! The session state machine never reads the clock itself. Callers pass `now` in, which is
//! what makes heartbeat and timeout behaviour testable without waiting real seconds.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, UTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UtcMillis(pub u64);

impl UtcMillis {
    pub fn now() -> Self {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after 1970");
        UtcMillis(elapsed.as_millis() as u64)
    }

    /// Milliseconds from `earlier` to `self`, or zero if `earlier` is later.
    pub fn since(self, earlier: UtcMillis) -> u64 {
        self.0.saturating_sub(earlier.0)
    }

    /// `YYYYMMDD-HH:MM:SS.sss`
    pub fn to_fix(self) -> String {
        let days = (self.0 / 86_400_000) as i64;
        let in_day = self.0 % 86_400_000;
        let (year, month, day) = civil_from_days(days);
        format!(
            "{year:04}{month:02}{day:02}-{:02}:{:02}:{:02}.{:03}",
            in_day / 3_600_000,
            in_day / 60_000 % 60,
            in_day / 1000 % 60,
            in_day % 1000
        )
    }

    /// Parses `YYYYMMDD-HH:MM:SS` with optional `.sss`.
    pub fn parse_fix(text: &str) -> Option<UtcMillis> {
        let bytes = text.as_bytes();
        if !(bytes.len() == 17 || bytes.len() == 21) {
            return None;
        }
        let number = |range: std::ops::Range<usize>| -> Option<u64> {
            let part = text.get(range)?;
            part.bytes()
                .all(|b| b.is_ascii_digit())
                .then(|| part.parse().ok())?
        };
        if bytes[8] != b'-' || bytes[11] != b':' || bytes[14] != b':' {
            return None;
        }
        let (year, month, day) = (number(0..4)?, number(4..6)?, number(6..8)?);
        let (hour, minute, second) = (number(9..11)?, number(12..14)?, number(15..17)?);
        let millis = if bytes.len() == 21 {
            if bytes[17] != b'.' {
                return None;
            }
            number(18..21)?
        } else {
            0
        };
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
            return None;
        }
        if second > 60 {
            return None; // 60 allows a leap second, as the FIX spec does
        }
        let days = days_from_civil(year as i64, month as u32, day as u32);
        let seconds = days as u64 * 86_400 + hour * 3600 + minute * 60 + second;
        Some(UtcMillis(seconds * 1000 + millis))
    }
}

/// Days since 1970-01-01 to a calendar date. Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The inverse of [`civil_from_days`].
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let month = month as i64;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(UtcMillis(0).to_fix(), "19700101-00:00:00.000");
        // 2026-09-07 14:32:11.123 UTC
        assert_eq!(
            UtcMillis(1_788_791_531_123).to_fix(),
            "20260907-14:32:11.123"
        );
        // leap day
        assert_eq!(
            UtcMillis(1_709_164_800_000).to_fix(),
            "20240229-00:00:00.000"
        );
    }

    #[test]
    fn parses_what_it_formats() {
        for millis in [0, 1_709_164_800_000, 1_788_791_531_123, 4_102_444_799_999] {
            let text = UtcMillis(millis).to_fix();
            assert_eq!(
                UtcMillis::parse_fix(&text),
                Some(UtcMillis(millis)),
                "{text}"
            );
        }
        assert_eq!(
            UtcMillis::parse_fix("20260907-14:32:11"),
            Some(UtcMillis(1_788_791_531_000))
        );
    }

    #[test]
    fn rejects_malformed_timestamps() {
        for bad in [
            "",
            "20260907 14:32:11",
            "20261307-14:32:11",
            "20260907-24:00:00",
            "20260907-14:32:11.12",
            "2026090x-14:32:11",
        ] {
            assert_eq!(UtcMillis::parse_fix(bad), None, "{bad:?}");
        }
    }
}
