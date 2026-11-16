//! The venue's activity (ADR 0016): counted as it happens, turned into per-second figures
//! once a second, and published on the market data feed as `VenueStats`.
//!
//! Only totals across every session are kept, never who did what, so nothing published can
//! tell one participant's activity from another's.

use std::time::Instant;

use md_publisher::public::VenueActivity;

/// Counts since the last [`Activity::take`].
#[derive(Debug)]
pub struct Activity {
    since: Instant,
    new_orders: u64,
    cancels: u64,
    rejects: u64,
    trades: u64,
    shares: i64,
    notional_cents: i64,
    fix_in: u64,
    fix_out: u64,
    feed_messages: u64,
    /// How long each order or cancel took to answer, in microseconds.
    answers_us: Vec<u32>,
}

/// What is true now, rather than counted: added to the counts when they are taken.
pub struct Now<'a> {
    pub business_date: &'a str,
    pub open_orders: usize,
    pub sessions: usize,
    pub transactions_today: u64,
    pub trades_today: u64,
}

impl Activity {
    pub fn new(now: Instant) -> Activity {
        Activity {
            since: now,
            new_orders: 0,
            cancels: 0,
            rejects: 0,
            trades: 0,
            shares: 0,
            notional_cents: 0,
            fix_in: 0,
            fix_out: 0,
            feed_messages: 0,
            answers_us: Vec::new(),
        }
    }

    pub fn fix_in(&mut self) {
        self.fix_in += 1;
    }

    pub fn fix_out(&mut self) {
        self.fix_out += 1;
    }

    pub fn new_order(&mut self) {
        self.new_orders += 1;
    }

    pub fn cancel(&mut self) {
        self.cancels += 1;
    }

    pub fn reject(&mut self) {
        self.rejects += 1;
    }

    pub fn trade(&mut self, qty: i64, price_cents: i64) {
        self.trades += 1;
        self.shares += qty;
        self.notional_cents += qty * price_cents;
    }

    pub fn feed_messages(&mut self, count: usize) {
        self.feed_messages += count as u64;
    }

    /// An order or cancel taken at `taken` was answered just now.
    pub fn answered(&mut self, taken: Instant, now: Instant) {
        let us = now.duration_since(taken).as_micros();
        self.answers_us.push(u32::try_from(us).unwrap_or(u32::MAX));
    }

    /// The figures since the last call, per second, and starts counting again.
    pub fn take(&mut self, now: Instant, state: Now) -> VenueActivity {
        let elapsed = now.duration_since(self.since);
        let secs = elapsed.as_secs_f64().max(0.001);
        let rate = |count: f64| count / secs;
        self.answers_us.sort_unstable();
        let at = |q: f64| -> u32 {
            if self.answers_us.is_empty() {
                return 0;
            }
            let i = ((q * self.answers_us.len() as f64) as usize).min(self.answers_us.len() - 1);
            self.answers_us[i]
        };
        let activity = VenueActivity {
            interval_ms: u32::try_from(elapsed.as_millis()).unwrap_or(u32::MAX),
            business_date: state.business_date.to_string(),
            transactions_per_sec: rate((self.new_orders + self.cancels) as f64),
            new_orders_per_sec: rate(self.new_orders as f64),
            cancels_per_sec: rate(self.cancels as f64),
            rejects_per_sec: rate(self.rejects as f64),
            trades_per_sec: rate(self.trades as f64),
            shares_per_sec: rate(self.shares as f64),
            notional_cents_per_sec: rate(self.notional_cents as f64),
            fix_in_per_sec: rate(self.fix_in as f64),
            fix_out_per_sec: rate(self.fix_out as f64),
            feed_messages_per_sec: rate(self.feed_messages as f64),
            answer_p50_us: at(0.5),
            answer_p99_us: at(0.99),
            open_orders: u32::try_from(state.open_orders).unwrap_or(u32::MAX),
            sessions: u32::try_from(state.sessions).unwrap_or(u32::MAX),
            transactions_today: state.transactions_today,
            trades_today: state.trades_today,
        };
        *self = Activity::new(now);
        activity
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn counts_become_rates_over_the_interval_and_start_again() {
        let start = Instant::now();
        let mut activity = Activity::new(start);
        for _ in 0..30 {
            activity.new_order();
        }
        for _ in 0..10 {
            activity.cancel();
        }
        activity.trade(100, 4_210);
        activity.trade(50, 4_212);
        for us in 1..=100 {
            activity.answered(start, start + Duration::from_micros(us));
        }
        let now = Now {
            business_date: "2026-11-16",
            open_orders: 7,
            sessions: 2,
            transactions_today: 1_000,
            trades_today: 90,
        };
        let a = activity.take(start + Duration::from_secs(2), now);
        assert_eq!(a.interval_ms, 2_000);
        assert_eq!(a.transactions_per_sec, 20.0);
        assert_eq!(a.new_orders_per_sec, 15.0);
        assert_eq!(a.cancels_per_sec, 5.0);
        assert_eq!(a.trades_per_sec, 1.0);
        assert_eq!(a.shares_per_sec, 75.0);
        assert_eq!(
            a.notional_cents_per_sec,
            (100.0 * 4_210.0 + 50.0 * 4_212.0) / 2.0
        );
        assert_eq!((a.answer_p50_us, a.answer_p99_us), (51, 100));
        assert_eq!(
            (a.open_orders, a.sessions, a.transactions_today),
            (7, 2, 1_000)
        );

        // Taken: the next interval starts from nothing.
        let quiet = Now {
            business_date: "2026-11-16",
            open_orders: 7,
            sessions: 2,
            transactions_today: 1_000,
            trades_today: 90,
        };
        let b = activity.take(start + Duration::from_secs(3), quiet);
        assert_eq!((b.transactions_per_sec, b.answer_p99_us), (0.0, 0));
    }
}
