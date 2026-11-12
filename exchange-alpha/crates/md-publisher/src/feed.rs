//! Sequencing and book state. Pure: given the same events it produces the same messages,
//! which is what lets a journal replay rebuild it exactly.

use std::collections::{BTreeMap, HashMap, VecDeque};

use matching_engine::Side;
use serde::{Deserialize, Serialize};

use crate::proto::{
    self, BookDelta, FeedMessage, Heartbeat, PriceLevel, Snapshot, TradePrint, feed_message,
};
use crate::public::PublicEvent;

/// Levels per side in a snapshot when the subscriber does not ask for a number.
pub const DEFAULT_DEPTH: usize = 10;
/// The most levels per side a snapshot will carry.
pub const MAX_DEPTH: usize = 50;
/// How many recent messages are kept for diagnosing gaps.
pub const RECENT_CAPACITY: usize = 1024;

/// One price level as the public sees it: total size and how many orders make it up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Level {
    pub qty: i64,
    pub order_count: i32,
}

/// A symbol's book as price levels only. Built from `Level` events alone, so it never holds
/// an order, let alone an owner.
#[derive(Debug, Default)]
struct Book {
    bids: BTreeMap<i64, Level>,
    asks: BTreeMap<i64, Level>,
}

/// Where the feed's numbering stands: the last `feed_seq` and each symbol's last
/// `symbol_seq`. The only part of the feed that a snapshot must carry, because the levels
/// are always the engine's own levels and can be rebuilt from its book.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sequence {
    pub feed_seq: u64,
    /// Symbols that have never published are absent: their last `symbol_seq` is zero.
    pub symbol_seqs: BTreeMap<String, u64>,
}

impl Sequence {
    /// Takes the next numbers for one message about `symbol`: `(feed_seq, symbol_seq)`.
    pub fn next(&mut self, symbol: &str) -> (u64, u64) {
        self.feed_seq += 1;
        let symbol_seq = self.symbol_seqs.entry(symbol.to_string()).or_default();
        *symbol_seq += 1;
        (self.feed_seq, *symbol_seq)
    }

    pub fn symbol_seq(&self, symbol: &str) -> u64 {
        self.symbol_seqs.get(symbol).copied().unwrap_or(0)
    }
}

pub struct Feed {
    venue: String,
    sequence: Sequence,
    books: HashMap<String, Book>,
    recent: VecDeque<FeedMessage>,
}

impl Feed {
    /// A feed for `symbols`, all with empty books and nothing yet sequenced.
    pub fn new(venue: impl Into<String>, symbols: impl IntoIterator<Item = String>) -> Feed {
        Feed {
            venue: venue.into(),
            sequence: Sequence::default(),
            books: symbols
                .into_iter()
                .map(|symbol| (symbol, Book::default()))
                .collect(),
            recent: VecDeque::with_capacity(RECENT_CAPACITY),
        }
    }

    /// The feed as it stood when `sequence` and `engine` were captured together: the same
    /// numbering, and every level the engine's book has. The recent-messages buffer starts
    /// empty; it is only ever for diagnosing gaps.
    pub fn restore(
        venue: impl Into<String>,
        symbols: impl IntoIterator<Item = String>,
        sequence: Sequence,
        engine: &matching_engine::Snapshot,
    ) -> Feed {
        let mut feed = Feed::new(venue, symbols);
        feed.sequence = sequence;
        for snapshot in &engine.books {
            let book = feed.books.entry(snapshot.symbol.clone()).or_default();
            let sides = [
                (&mut book.bids, &snapshot.bids),
                (&mut book.asks, &snapshot.asks),
            ];
            for (levels, from) in sides {
                for level in from {
                    let order_count = count(level.orders.len());
                    let qty = level.qty.0;
                    levels.insert(level.price.0, Level { qty, order_count });
                }
            }
        }
        feed
    }

    /// The numbering so far. With the engine's book, everything [`restore`](Self::restore)
    /// needs.
    pub fn sequence(&self) -> &Sequence {
        &self.sequence
    }

    pub fn venue(&self) -> &str {
        &self.venue
    }

    /// The last `feed_seq` used. Zero before anything has traded or rested.
    pub fn feed_seq(&self) -> u64 {
        self.sequence.feed_seq
    }

    pub fn is_listed(&self, symbol: &str) -> bool {
        self.books.contains_key(symbol)
    }

    /// Applies one public event to the book, gives it the next `feed_seq` and `symbol_seq`,
    /// and returns the message to broadcast.
    pub fn publish(&mut self, event: &PublicEvent, ts_ns: i64) -> FeedMessage {
        let (feed_seq, symbol_seq) = self.sequence.next(event.symbol());
        let book = self.books.entry(event.symbol().to_string()).or_default();

        let payload = match event {
            PublicEvent::Level {
                symbol,
                side,
                price,
                qty,
                order_count,
            } => {
                let levels = match side {
                    Side::Buy => &mut book.bids,
                    Side::Sell => &mut book.asks,
                };
                let order_count = count(*order_count);
                if qty.is_zero() {
                    levels.remove(&price.0);
                } else {
                    levels.insert(
                        price.0,
                        Level {
                            qty: qty.0,
                            order_count,
                        },
                    );
                }
                feed_message::Payload::BookDelta(BookDelta {
                    venue: self.venue.clone(),
                    symbol: symbol.clone(),
                    feed_seq,
                    ts_ns,
                    side: wire_side(*side).into(),
                    price_cents: price.0,
                    qty: qty.0,
                    order_count,
                    symbol_seq,
                })
            }
            PublicEvent::Trade {
                trade_id,
                symbol,
                price,
                qty,
                aggressor_side,
            } => feed_message::Payload::TradePrint(TradePrint {
                venue: self.venue.clone(),
                symbol: symbol.clone(),
                feed_seq,
                ts_ns,
                trade_id: trade_id.0.to_string(),
                price_cents: price.0,
                qty: qty.0,
                aggressor_side: wire_side(*aggressor_side).into(),
                symbol_seq,
            }),
        };

        let message = FeedMessage {
            payload: Some(payload),
        };
        if self.recent.len() == RECENT_CAPACITY {
            self.recent.pop_front();
        }
        self.recent.push_back(message.clone());
        message
    }

    /// The book for `symbol` as of the latest sequence numbers, `depth` levels per side,
    /// best first. `None` if the symbol is not listed.
    pub fn snapshot(&self, symbol: &str, depth: usize, ts_ns: i64) -> Option<Snapshot> {
        let book = self.books.get(symbol)?;
        let depth = depth.clamp(1, MAX_DEPTH);
        let level = |(price, level): (&i64, &Level)| PriceLevel {
            price_cents: *price,
            qty: level.qty,
            order_count: level.order_count,
        };
        Some(Snapshot {
            venue: self.venue.clone(),
            symbol: symbol.to_string(),
            feed_seq: self.sequence.feed_seq,
            ts_ns,
            bids: book.bids.iter().rev().take(depth).map(level).collect(),
            asks: book.asks.iter().take(depth).map(level).collect(),
            depth_limit: depth as i32,
            symbol_seq: self.sequence.symbol_seq(symbol),
        })
    }

    /// A heartbeat carrying the latest `feed_seq`. Takes no number of its own, so sending
    /// one changes nothing a replay would need to reproduce.
    pub fn heartbeat(&self, ts_ns: i64) -> FeedMessage {
        FeedMessage {
            payload: Some(feed_message::Payload::Heartbeat(Heartbeat {
                venue: self.venue.clone(),
                feed_seq: self.sequence.feed_seq,
                ts_ns,
            })),
        }
    }

    /// The oldest and newest `feed_seq` still held in the recent-messages buffer.
    pub fn recent_range(&self) -> Option<(u64, u64)> {
        let first = self.recent.front()?.feed_seq();
        let last = self.recent.back()?.feed_seq();
        Some((first, last))
    }

    /// Recent messages, oldest first. Up to [`RECENT_CAPACITY`] of them.
    pub fn recent(&self) -> impl Iterator<Item = &FeedMessage> {
        self.recent.iter()
    }
}

fn wire_side(side: Side) -> proto::Side {
    match side {
        Side::Buy => proto::Side::Buy,
        Side::Sell => proto::Side::Sell,
    }
}

/// A level's order count on the wire. More than two billion orders at one price is not a
/// real situation, so saturating is fine.
fn count(order_count: usize) -> i32 {
    i32::try_from(order_count).unwrap_or(i32::MAX)
}

impl FeedMessage {
    pub fn feed_seq(&self) -> u64 {
        match &self.payload {
            Some(feed_message::Payload::Snapshot(m)) => m.feed_seq,
            Some(feed_message::Payload::BookDelta(m)) => m.feed_seq,
            Some(feed_message::Payload::TradePrint(m)) => m.feed_seq,
            Some(feed_message::Payload::Heartbeat(m)) => m.feed_seq,
            None => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use matching_engine::{PriceCents, Qty, TradeId};

    use super::*;

    fn level(symbol: &str, side: Side, price: i64, qty: i64) -> PublicEvent {
        PublicEvent::Level {
            symbol: symbol.into(),
            side,
            price: PriceCents(price),
            qty: Qty(qty),
            order_count: 1,
        }
    }

    fn feed() -> Feed {
        Feed::new("ALPHA", ["ACME".to_string(), "BLTZ".to_string()])
    }

    fn seqs(message: &FeedMessage) -> (u64, u64) {
        match &message.payload {
            Some(feed_message::Payload::BookDelta(m)) => (m.feed_seq, m.symbol_seq),
            Some(feed_message::Payload::TradePrint(m)) => (m.feed_seq, m.symbol_seq),
            other => panic!("not sequenced: {other:?}"),
        }
    }

    #[test]
    fn feed_seq_counts_the_venue_and_symbol_seq_counts_each_symbol() {
        let mut feed = feed();
        let a1 = feed.publish(&level("ACME", Side::Buy, 4200, 100), 0);
        let b1 = feed.publish(&level("BLTZ", Side::Buy, 1800, 100), 0);
        let a2 = feed.publish(&level("ACME", Side::Sell, 4210, 50), 0);
        assert_eq!(seqs(&a1), (1, 1));
        assert_eq!(seqs(&b1), (2, 1));
        assert_eq!(seqs(&a2), (3, 2));
    }

    #[test]
    fn heartbeats_and_snapshots_take_no_number() {
        let mut feed = feed();
        feed.publish(&level("ACME", Side::Buy, 4200, 100), 0);
        let heartbeat = feed.heartbeat(0);
        let snapshot = feed.snapshot("ACME", 10, 0).unwrap();
        assert_eq!(heartbeat.feed_seq(), 1);
        assert_eq!((snapshot.feed_seq, snapshot.symbol_seq), (1, 1));
        let next = feed.publish(&level("ACME", Side::Buy, 4200, 0), 0);
        assert_eq!(seqs(&next), (2, 2));
    }

    #[test]
    fn a_zero_quantity_removes_the_level() {
        let mut feed = feed();
        feed.publish(&level("ACME", Side::Buy, 4200, 100), 0);
        feed.publish(&level("ACME", Side::Buy, 4199, 100), 0);
        feed.publish(&level("ACME", Side::Buy, 4200, 0), 0);
        let snapshot = feed.snapshot("ACME", 10, 0).unwrap();
        let prices: Vec<i64> = snapshot.bids.iter().map(|l| l.price_cents).collect();
        assert_eq!(prices, [4199]);
    }

    #[test]
    fn snapshots_are_best_first_and_truncated() {
        let mut feed = feed();
        for price in [4201, 4203, 4202] {
            feed.publish(&level("ACME", Side::Buy, price, 10), 0);
        }
        for price in [4212, 4210, 4211] {
            feed.publish(&level("ACME", Side::Sell, price, 10), 0);
        }
        let snapshot = feed.snapshot("ACME", 2, 0).unwrap();
        let bids: Vec<i64> = snapshot.bids.iter().map(|l| l.price_cents).collect();
        let asks: Vec<i64> = snapshot.asks.iter().map(|l| l.price_cents).collect();
        assert_eq!(bids, [4203, 4202]);
        assert_eq!(asks, [4210, 4211]);
        assert_eq!(snapshot.depth_limit, 2);
        assert!(feed.snapshot("NOPE", 10, 0).is_none());
    }

    #[test]
    fn the_recent_buffer_keeps_only_the_newest() {
        let mut feed = feed();
        assert_eq!(feed.recent_range(), None);
        for n in 0..RECENT_CAPACITY + 5 {
            feed.publish(
                &PublicEvent::Trade {
                    trade_id: TradeId(n as u64 + 1),
                    symbol: "ACME".into(),
                    price: PriceCents(4200),
                    qty: Qty(1),
                    aggressor_side: Side::Buy,
                },
                0,
            );
        }
        assert_eq!(feed.recent().count(), RECENT_CAPACITY);
        assert_eq!(feed.recent_range(), Some((6, RECENT_CAPACITY as u64 + 5)));
    }
}
