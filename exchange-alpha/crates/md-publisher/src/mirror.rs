//! The subscriber's side of the feed: one symbol's book, rebuilt from messages alone.
//!
//! This is what every consumer of the feed has to do, written down once by the venue that
//! publishes it. `md-watch` and the tests use it; the broker writes its own in TypeScript
//! against the same spec.
//!
//! The rules:
//!
//! 1. Nothing counts until a `Snapshot` arrives. It sets the book and `symbol_seq`.
//! 2. A message with `symbol_seq` at or below the current one is old news (it was already
//!    in the snapshot) and is ignored.
//! 3. The next one, `symbol_seq + 1`, is applied.
//! 4. Anything further ahead means messages were lost. The book is now wrong, so it is
//!    marked stale and ignores everything until a fresh `Snapshot` arrives.

use std::collections::BTreeMap;

use crate::feed::Level;
use crate::proto::{FeedMessage, PriceLevel, Side, TradePrint, feed_message};

/// What one message did to the mirror.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// A snapshot replaced the book.
    Snapshot { symbol_seq: u64 },
    /// The next message in sequence was applied.
    Applied { symbol_seq: u64 },
    /// Lost messages. The book is stale until the next snapshot: ask for one.
    Gap { expected: u64, received: u64 },
    /// Ignored: a different symbol, a heartbeat, old news, or waiting for a snapshot.
    Ignored,
}

#[derive(Debug)]
pub struct Mirror {
    symbol: String,
    bids: BTreeMap<i64, Level>,
    asks: BTreeMap<i64, Level>,
    /// `None` until a snapshot arrives, and again after a gap.
    symbol_seq: Option<u64>,
    last_trade: Option<TradePrint>,
}

impl Mirror {
    pub fn new(symbol: impl Into<String>) -> Mirror {
        Mirror {
            symbol: symbol.into(),
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            symbol_seq: None,
            last_trade: None,
        }
    }

    pub fn symbol(&self) -> &str {
        &self.symbol
    }

    /// The last `symbol_seq` applied, or `None` while waiting for a snapshot.
    pub fn symbol_seq(&self) -> Option<u64> {
        self.symbol_seq
    }

    pub fn last_trade(&self) -> Option<&TradePrint> {
        self.last_trade.as_ref()
    }

    /// Price levels on one side, best first, as `(price_cents, level)`.
    pub fn levels(&self, side: Side) -> Vec<(i64, Level)> {
        let entries = |levels: &BTreeMap<i64, Level>| -> Vec<(i64, Level)> {
            levels
                .iter()
                .map(|(price, level)| (*price, *level))
                .collect()
        };
        match side {
            Side::Buy => entries(&self.bids).into_iter().rev().collect(),
            _ => entries(&self.asks),
        }
    }

    pub fn apply(&mut self, message: &FeedMessage) -> Applied {
        use feed_message::Payload;
        match &message.payload {
            Some(Payload::Snapshot(snapshot)) if snapshot.symbol == self.symbol => {
                self.bids = levels(&snapshot.bids);
                self.asks = levels(&snapshot.asks);
                self.symbol_seq = Some(snapshot.symbol_seq);
                Applied::Snapshot {
                    symbol_seq: snapshot.symbol_seq,
                }
            }
            Some(Payload::BookDelta(delta)) if delta.symbol == self.symbol => {
                let applied = self.sequence(delta.symbol_seq);
                if matches!(applied, Applied::Applied { .. }) {
                    let side = if delta.side == Side::Buy as i32 {
                        &mut self.bids
                    } else {
                        &mut self.asks
                    };
                    if delta.qty == 0 {
                        side.remove(&delta.price_cents);
                    } else {
                        let level = Level {
                            qty: delta.qty,
                            order_count: delta.order_count,
                        };
                        side.insert(delta.price_cents, level);
                    }
                }
                applied
            }
            Some(Payload::TradePrint(trade)) if trade.symbol == self.symbol => {
                let applied = self.sequence(trade.symbol_seq);
                if matches!(applied, Applied::Applied { .. }) {
                    self.last_trade = Some(trade.clone());
                }
                applied
            }
            _ => Applied::Ignored,
        }
    }

    fn sequence(&mut self, received: u64) -> Applied {
        let Some(current) = self.symbol_seq else {
            return Applied::Ignored;
        };
        if received <= current {
            Applied::Ignored
        } else if received == current + 1 {
            self.symbol_seq = Some(received);
            Applied::Applied {
                symbol_seq: received,
            }
        } else {
            self.symbol_seq = None;
            Applied::Gap {
                expected: current + 1,
                received,
            }
        }
    }
}

fn levels(levels: &[PriceLevel]) -> BTreeMap<i64, Level> {
    levels
        .iter()
        .map(|level| {
            let value = Level {
                qty: level.qty,
                order_count: level.order_count,
            };
            (level.price_cents, value)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use matching_engine::{PriceCents, Qty};

    use super::*;
    use crate::feed::Feed;
    use crate::public::PublicEvent;

    fn level(price: i64, qty: i64) -> PublicEvent {
        PublicEvent::Level {
            symbol: "ACME".into(),
            side: matching_engine::Side::Buy,
            price: PriceCents(price),
            qty: Qty(qty),
            order_count: 1,
        }
    }

    fn snapshot(feed: &Feed) -> FeedMessage {
        FeedMessage {
            payload: Some(feed_message::Payload::Snapshot(
                feed.snapshot("ACME", 10, 0).unwrap(),
            )),
        }
    }

    #[test]
    fn deltas_before_the_snapshot_and_already_in_it_are_ignored() {
        let mut feed = Feed::new("ALPHA", ["ACME".to_string()]);
        let mut mirror = Mirror::new("ACME");
        let early = feed.publish(&level(4200, 100), 0);
        assert_eq!(mirror.apply(&early), Applied::Ignored);

        assert_eq!(
            mirror.apply(&snapshot(&feed)),
            Applied::Snapshot { symbol_seq: 1 }
        );
        assert_eq!(mirror.apply(&early), Applied::Ignored); // old news, already in it

        let next = feed.publish(&level(4199, 50), 0);
        assert_eq!(mirror.apply(&next), Applied::Applied { symbol_seq: 2 });
        let bids: Vec<i64> = mirror.levels(Side::Buy).iter().map(|l| l.0).collect();
        assert_eq!(bids, [4200, 4199]);
    }

    #[test]
    fn a_gap_makes_the_book_stale_until_the_next_snapshot() {
        let mut feed = Feed::new("ALPHA", ["ACME".to_string()]);
        let mut mirror = Mirror::new("ACME");
        mirror.apply(&snapshot(&feed));
        feed.publish(&level(4200, 100), 0); // lost in transit
        let after = feed.publish(&level(4200, 0), 0);
        assert_eq!(
            mirror.apply(&after),
            Applied::Gap {
                expected: 1,
                received: 2
            }
        );
        let later = feed.publish(&level(4201, 10), 0);
        assert_eq!(mirror.apply(&later), Applied::Ignored);
        assert_eq!(mirror.symbol_seq(), None);

        assert_eq!(
            mirror.apply(&snapshot(&feed)),
            Applied::Snapshot { symbol_seq: 3 }
        );
        assert_eq!(
            mirror.levels(Side::Buy),
            [(
                4201,
                Level {
                    qty: 10,
                    order_count: 1
                }
            )]
        );
    }
}
