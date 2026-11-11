//! One instrument's order book.
//!
//! Each side is a sorted map from price to a FIFO queue of the orders resting at that price.
//! The sort gives **price priority**; the queue gives **time priority**, because a later
//! order at the same price joins the back and waits its turn. That pair is the whole of
//! price-time priority.

use std::collections::VecDeque;
use std::collections::btree_map::{BTreeMap, OccupiedEntry};

use serde::{Deserialize, Serialize};

use crate::types::{OrderId, PriceCents, Qty, Side};

/// An order waiting in the book. Its side and price are implied by where it sits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestingOrder {
    pub order_id: OrderId,
    pub client_order_id: String,
    pub participant: String,
    /// Quantity still waiting to trade. Never zero: a fully filled order leaves the book.
    pub remaining: Qty,
}

/// A summary of one price level: what the public market data feed shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LevelView {
    pub price: PriceCents,
    pub qty: Qty,
    pub order_count: usize,
}

/// Every order resting at one price, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Level {
    pub(crate) orders: VecDeque<RestingOrder>,
    /// Sum of `remaining` across `orders`, kept up to date so a level's size is O(1).
    pub(crate) total: Qty,
}

/// One execution against one resting order.
pub(crate) struct Fill {
    pub(crate) resting_order_id: OrderId,
    pub(crate) resting_participant: String,
    pub(crate) price: PriceCents,
    pub(crate) qty: Qty,
    /// The resting order has nothing left and has been removed from the book.
    pub(crate) resting_filled: bool,
}

/// The result of an incoming order taking liquidity.
pub(crate) struct Taken {
    pub(crate) fills: Vec<Fill>,
    /// Incoming quantity that did not trade.
    pub(crate) remaining: Qty,
    /// Matching stopped because the next order in line was the taker's own.
    pub(crate) stopped_by_self_trade: bool,
}

/// One side of the book.
///
/// Both sides key on the plain price; only the meaning of "best" differs (the highest bid,
/// the lowest ask), so the side decides which end of the map to read. Keeping one key type
/// means a lookup by price is the same code on both sides.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HalfBook {
    side: Side,
    levels: BTreeMap<PriceCents, Level>,
}

impl HalfBook {
    fn new(side: Side) -> Self {
        Self {
            side,
            levels: BTreeMap::new(),
        }
    }

    fn best_price(&self) -> Option<PriceCents> {
        let best = match self.side {
            Side::Buy => self.levels.last_key_value(),
            Side::Sell => self.levels.first_key_value(),
        };
        best.map(|(price, _)| *price)
    }

    fn best_level(&mut self) -> Option<OccupiedEntry<'_, PriceCents, Level>> {
        match self.side {
            Side::Buy => self.levels.last_entry(),
            Side::Sell => self.levels.first_entry(),
        }
    }

    /// Levels from best to worst.
    fn best_first(&self) -> Box<dyn Iterator<Item = (PriceCents, &Level)> + '_> {
        let levels = self.levels.iter().map(|(price, level)| (*price, level));
        match self.side {
            Side::Buy => Box::new(levels.rev()),
            Side::Sell => Box::new(levels),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderBook {
    bids: HalfBook,
    asks: HalfBook,
}

impl Default for OrderBook {
    fn default() -> Self {
        Self {
            bids: HalfBook::new(Side::Buy),
            asks: HalfBook::new(Side::Sell),
        }
    }
}

impl OrderBook {
    pub fn best_bid(&self) -> Option<PriceCents> {
        self.bids.best_price()
    }

    pub fn best_ask(&self) -> Option<PriceCents> {
        self.asks.best_price()
    }

    /// Best ask minus best bid, when both sides have orders.
    pub fn spread(&self) -> Option<PriceCents> {
        Some(PriceCents(self.best_ask()?.0 - self.best_bid()?.0))
    }

    /// True if the best bid is at or above the best ask. Matching exists to make this
    /// impossible, so a crossed book is always a bug.
    pub fn is_crossed(&self) -> bool {
        matches!((self.best_bid(), self.best_ask()), (Some(bid), Some(ask)) if bid >= ask)
    }

    pub fn is_empty(&self) -> bool {
        self.bids.levels.is_empty() && self.asks.levels.is_empty()
    }

    /// Price levels on one side, best first.
    pub fn depth(&self, side: Side) -> impl Iterator<Item = LevelView> + '_ {
        self.half(side)
            .best_first()
            .map(|(price, level)| view(price, level))
    }

    /// One price level, if any orders rest there.
    pub fn level(&self, side: Side, price: PriceCents) -> Option<LevelView> {
        self.half(side)
            .levels
            .get(&price)
            .map(|level| view(price, level))
    }

    pub(crate) fn levels_best_first(
        &self,
        side: Side,
    ) -> impl Iterator<Item = (PriceCents, &Level)> + '_ {
        self.half(side).best_first()
    }

    /// Adds an order to the back of the queue at its price.
    pub(crate) fn rest(&mut self, side: Side, price: PriceCents, order: RestingOrder) {
        let level = self.half_mut(side).levels.entry(price).or_default();
        level.total += order.remaining;
        level.orders.push_back(order);
    }

    /// Removes one resting order. Finding its level is a map lookup; finding it within the
    /// level is a scan of that level's queue, which is fine while levels stay short. If deep
    /// levels ever make cancels slow, the fix is an intrusive linked list per level.
    pub(crate) fn remove(
        &mut self,
        side: Side,
        price: PriceCents,
        order_id: OrderId,
    ) -> Option<RestingOrder> {
        let half = self.half_mut(side);
        let level = half.levels.get_mut(&price)?;
        let position = level.orders.iter().position(|o| o.order_id == order_id)?;
        let order = level.orders.remove(position)?;
        level.total -= order.remaining;
        if level.orders.is_empty() {
            half.levels.remove(&price);
        }
        Some(order)
    }

    /// How much an incoming order could trade right now, without changing anything.
    ///
    /// Walks the book exactly as [`take`](Self::take) would, including stopping at the
    /// taker's own order, so a fill-or-kill decision always agrees with what matching does.
    pub(crate) fn fillable(
        &self,
        taker_side: Side,
        limit: Option<PriceCents>,
        taker: &str,
        wanted: Qty,
    ) -> Qty {
        let mut available = Qty::ZERO;
        for (price, level) in self.half(taker_side.opposite()).best_first() {
            if !crosses(taker_side, price, limit) {
                break;
            }
            for order in &level.orders {
                if order.participant == taker || available >= wanted {
                    return available;
                }
                available += order.remaining;
            }
        }
        available
    }

    /// Matches an incoming order against the opposite side, best price first and oldest
    /// first within a price, until it is filled, runs out of acceptable prices, or reaches
    /// one of the taker's own orders.
    pub(crate) fn take(
        &mut self,
        taker_side: Side,
        limit: Option<PriceCents>,
        mut qty: Qty,
        taker: &str,
    ) -> Taken {
        let resting_side = self.half_mut(taker_side.opposite());
        let mut fills = Vec::new();

        while !qty.is_zero() {
            let Some(mut entry) = resting_side.best_level() else {
                break; // nothing left on the other side
            };
            let price = *entry.key();
            if !crosses(taker_side, price, limit) {
                break; // the best remaining price is worse than the taker will accept
            }

            let level = entry.get_mut();
            let front = level.orders.front_mut().expect("empty levels are removed");
            if front.participant == taker {
                return Taken {
                    fills,
                    remaining: qty,
                    stopped_by_self_trade: true,
                };
            }

            let traded = qty.min(front.remaining);
            front.remaining -= traded;
            let resting_filled = front.remaining.is_zero();
            fills.push(Fill {
                resting_order_id: front.order_id,
                resting_participant: front.participant.clone(),
                price,
                qty: traded,
                resting_filled,
            });
            level.total -= traded;
            qty -= traded;

            if resting_filled {
                level.orders.pop_front();
                if level.orders.is_empty() {
                    entry.remove();
                }
            }
        }

        Taken {
            fills,
            remaining: qty,
            stopped_by_self_trade: false,
        }
    }

    fn half(&self, side: Side) -> &HalfBook {
        match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    fn half_mut(&mut self, side: Side) -> &mut HalfBook {
        match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }
}

/// Would an incoming order on `taker_side` trade at a resting `price`?
/// A buyer takes asks at or below its limit; a seller takes bids at or above it. A market
/// order (no limit) takes any price.
fn crosses(taker_side: Side, price: PriceCents, limit: Option<PriceCents>) -> bool {
    match (taker_side, limit) {
        (_, None) => true,
        (Side::Buy, Some(limit)) => price <= limit,
        (Side::Sell, Some(limit)) => price >= limit,
    }
}

fn view(price: PriceCents, level: &Level) -> LevelView {
    LevelView {
        price,
        qty: level.total,
        order_count: level.orders.len(),
    }
}
