//! The engine: one order book per symbol, plus the ids and indexes that span them.
//!
//! `apply` is the only way in. It is single-threaded and deterministic: given the same
//! commands in the same order it produces the same book and the same events, every time.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::book::{OrderBook, RestingOrder};
use crate::command::{CancelOrder, Command, NewOrder};
use crate::event::{BookDelta, CancelReason, Event, RejectReason, Trade};
use crate::types::{OrderId, OrderType, PriceCents, Qty, Side, TimeInForce, TradeId};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Engine {
    /// A `BTreeMap` rather than a `HashMap` so iteration order, and therefore any output
    /// built from it, is the same on every run.
    books: BTreeMap<String, OrderBook>,
    /// Where each resting order lives, so a cancel goes straight to its price level instead
    /// of searching every book. Only ever used for lookups, never iterated, which is why a
    /// `HashMap` is safe here.
    locations: HashMap<OrderId, Location>,
    ids: Ids,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Location {
    symbol: String,
    side: Side,
    price: PriceCents,
    participant: String,
}

/// Monotonic id counters. Never reset: replaying the journal re-issues exactly the same ids,
/// which is how they survive a restart.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Ids {
    last_order: u64,
    last_trade: u64,
}

impl Ids {
    fn next_order(&mut self) -> OrderId {
        self.last_order += 1;
        OrderId(self.last_order)
    }

    fn next_trade(&mut self) -> TradeId {
        self.last_trade += 1;
        TradeId(self.last_trade)
    }
}

/// What happens to the part of an incoming order that did not trade.
enum Leftover {
    Rest(PriceCents),
    Cancel(CancelReason),
}

impl Engine {
    /// Applies one command and returns everything that happened as a result.
    pub fn apply(&mut self, command: Command) -> Vec<Event> {
        let mut events = Vec::new();
        match command {
            Command::New(order) => self.new_order(order, &mut events),
            Command::Cancel(cancel) => self.cancel(cancel, &mut events),
        }
        events
    }

    /// Rebuilds an engine by applying commands in order. This is recovery: the result is
    /// identical to the engine that originally processed them.
    pub fn replay(commands: impl IntoIterator<Item = Command>) -> Engine {
        let mut engine = Engine::default();
        for command in commands {
            engine.apply(command);
        }
        engine
    }

    pub fn book(&self, symbol: &str) -> Option<&OrderBook> {
        self.books.get(symbol)
    }

    pub fn books(&self) -> impl Iterator<Item = (&str, &OrderBook)> {
        self.books
            .iter()
            .map(|(symbol, book)| (symbol.as_str(), book))
    }

    pub fn resting_order_count(&self) -> usize {
        self.locations.len()
    }

    /// The full state as plain data, in a deterministic order. Two engines are in the same
    /// state exactly when their snapshots serialise to the same bytes.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            last_order_id: self.ids.last_order,
            last_trade_id: self.ids.last_trade,
            books: self
                .books
                .iter()
                .map(|(symbol, book)| BookSnapshot {
                    symbol: symbol.clone(),
                    bids: snapshot_side(book, Side::Buy),
                    asks: snapshot_side(book, Side::Sell),
                })
                .collect(),
        }
    }

    fn new_order(&mut self, order: NewOrder, events: &mut Vec<Event>) {
        if let Some(reason) = validate(&order) {
            events.push(Event::Rejected {
                client_order_id: order.client_order_id,
                participant: order.participant,
                reason,
            });
            return;
        }

        let order_id = self.ids.next_order();
        events.push(Event::Accepted {
            order_id,
            client_order_id: order.client_order_id.clone(),
            participant: order.participant.clone(),
            symbol: order.symbol.clone(),
            side: order.side,
            order_type: order.order_type,
            time_in_force: order.time_in_force,
            qty: order.qty,
        });

        let limit = order.order_type.limit_price();
        let book = self.books.entry(order.symbol.clone()).or_default();

        // Fill-or-kill is all or nothing, so decide before touching the book.
        if order.time_in_force == TimeInForce::Fok
            && book.fillable(order.side, limit, &order.participant, order.qty) < order.qty
        {
            events.push(cancelled(
                order_id,
                &order,
                order.qty,
                CancelReason::FillOrKill,
            ));
            return;
        }

        // Levels this command changed. Ordered, so book deltas come out in the same order
        // every time.
        let mut touched = BTreeSet::new();

        let taken = book.take(order.side, limit, order.qty, &order.participant);
        for fill in taken.fills {
            touched.insert((order.side.opposite(), fill.price));
            if fill.resting_filled {
                self.locations.remove(&fill.resting_order_id);
            }
            events.push(Event::Trade(Trade {
                trade_id: self.ids.next_trade(),
                symbol: order.symbol.clone(),
                price: fill.price,
                qty: fill.qty,
                aggressor_side: order.side,
                aggressor_order_id: order_id,
                aggressor_participant: order.participant.clone(),
                resting_order_id: fill.resting_order_id,
                resting_participant: fill.resting_participant,
            }));
        }

        if !taken.remaining.is_zero() {
            match leftover(&order, taken.stopped_by_self_trade) {
                Leftover::Cancel(reason) => {
                    events.push(cancelled(order_id, &order, taken.remaining, reason));
                }
                Leftover::Rest(price) => {
                    book.rest(
                        order.side,
                        price,
                        RestingOrder {
                            order_id,
                            client_order_id: order.client_order_id.clone(),
                            participant: order.participant.clone(),
                            remaining: taken.remaining,
                        },
                    );
                    self.locations.insert(
                        order_id,
                        Location {
                            symbol: order.symbol.clone(),
                            side: order.side,
                            price,
                            participant: order.participant.clone(),
                        },
                    );
                    touched.insert((order.side, price));
                }
            }
        }

        push_book_deltas(&order.symbol, book, &touched, events);
    }

    fn cancel(&mut self, cancel: CancelOrder, events: &mut Vec<Event>) {
        let is_theirs = self
            .locations
            .get(&cancel.order_id)
            .is_some_and(|location| location.participant == cancel.participant);
        if !is_theirs {
            events.push(Event::CancelRejected {
                order_id: cancel.order_id,
                participant: cancel.participant,
                reason: RejectReason::UnknownOrder,
            });
            return;
        }

        let location = self
            .locations
            .remove(&cancel.order_id)
            .expect("checked above");
        let book = self
            .books
            .get_mut(&location.symbol)
            .expect("a located order's book exists");
        let order = book
            .remove(location.side, location.price, cancel.order_id)
            .expect("the location index and the book agree");

        events.push(Event::Canceled {
            order_id: cancel.order_id,
            participant: cancel.participant,
            symbol: location.symbol.clone(),
            remaining: order.remaining,
            reason: CancelReason::Requested,
        });
        let touched = BTreeSet::from([(location.side, location.price)]);
        push_book_deltas(&location.symbol, book, &touched, events);
    }
}

/// The checks the engine itself needs. Everything market-specific (symbol, tick size, lot
/// size, price bands) is the gateway's job and has already happened.
fn validate(order: &NewOrder) -> Option<RejectReason> {
    if order.qty <= Qty::ZERO {
        return Some(RejectReason::InvalidQuantity);
    }
    match order.order_type {
        OrderType::Limit { price } if price <= PriceCents(0) => Some(RejectReason::InvalidPrice),
        _ => None,
    }
}

/// Decides the fate of an incoming order's untraded remainder.
fn leftover(order: &NewOrder, stopped_by_self_trade: bool) -> Leftover {
    if stopped_by_self_trade {
        return Leftover::Cancel(CancelReason::SelfTradePrevention);
    }
    match (order.order_type, order.time_in_force) {
        (OrderType::Market, _) => Leftover::Cancel(CancelReason::NoLiquidity),
        (OrderType::Limit { .. }, TimeInForce::Ioc) => {
            Leftover::Cancel(CancelReason::ImmediateOrCancel)
        }
        // Unreachable in practice: the fill-or-kill check guarantees a full fill.
        (OrderType::Limit { .. }, TimeInForce::Fok) => Leftover::Cancel(CancelReason::FillOrKill),
        (OrderType::Limit { price }, TimeInForce::Day | TimeInForce::Gtc) => Leftover::Rest(price),
    }
}

fn cancelled(order_id: OrderId, order: &NewOrder, remaining: Qty, reason: CancelReason) -> Event {
    Event::Canceled {
        order_id,
        participant: order.participant.clone(),
        symbol: order.symbol.clone(),
        remaining,
        reason,
    }
}

/// One delta per level that changed, carrying the level's new total (zero if it emptied).
fn push_book_deltas(
    symbol: &str,
    book: &OrderBook,
    touched: &BTreeSet<(Side, PriceCents)>,
    events: &mut Vec<Event>,
) {
    for &(side, price) in touched {
        let (qty, order_count) = book
            .level(side, price)
            .map_or((Qty::ZERO, 0), |level| (level.qty, level.order_count));
        events.push(Event::BookDelta(BookDelta {
            symbol: symbol.to_string(),
            side,
            price,
            qty,
            order_count,
        }));
    }
}

/// The engine's entire state as plain data. See [`Engine::snapshot`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub last_order_id: u64,
    pub last_trade_id: u64,
    pub books: Vec<BookSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookSnapshot {
    pub symbol: String,
    /// Best first.
    pub bids: Vec<LevelSnapshot>,
    /// Best first.
    pub asks: Vec<LevelSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LevelSnapshot {
    pub price: PriceCents,
    pub qty: Qty,
    /// Oldest first, which is the order they will fill in.
    pub orders: Vec<RestingOrder>,
}

fn snapshot_side(book: &OrderBook, side: Side) -> Vec<LevelSnapshot> {
    book.levels_best_first(side)
        .map(|(price, level)| LevelSnapshot {
            price,
            qty: level.total,
            orders: level.orders.iter().cloned().collect(),
        })
        .collect()
}
