//! What the engine reports.
//!
//! One command produces zero or more events, always in this order:
//!
//! 1. `Accepted` or `Rejected` (for a cancel, `Canceled` or `CancelRejected`)
//! 2. one `Trade` per resting order matched, best price first
//! 3. `Canceled`, if part of the incoming order was not allowed to rest
//! 4. one `BookDelta` per price level that changed
//!
//! The engine does not decide who sees what. The gateway turns events about an order into
//! private execution reports for that order's owner; md-publisher turns `Trade` and
//! `BookDelta` into the public, anonymous feed. A `Trade` names both participants, so it must
//! never be published as-is.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::types::{OrderId, OrderType, PriceCents, Qty, Side, TimeInForce, TradeId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Event {
    /// The order passed the engine's checks and was given an id.
    Accepted {
        order_id: OrderId,
        client_order_id: String,
        participant: String,
        symbol: String,
        side: Side,
        order_type: OrderType,
        time_in_force: TimeInForce,
        qty: Qty,
    },
    /// The order was refused outright. It never touched the book.
    Rejected {
        client_order_id: String,
        participant: String,
        reason: RejectReason,
    },
    Trade(Trade),
    /// Quantity removed from an order without trading.
    Canceled {
        order_id: OrderId,
        participant: String,
        symbol: String,
        /// How much was cancelled: the untraded remainder.
        remaining: Qty,
        reason: CancelReason,
    },
    /// A cancel request that could not be carried out. The order, if it exists, is untouched.
    CancelRejected {
        order_id: OrderId,
        participant: String,
        reason: RejectReason,
    },
    BookDelta(BookDelta),
    /// The business day closed. Always the last event of an `EndOfDay` command, after every
    /// expiry. Carries nothing about any order: it tells layers above that keep per-day
    /// state (the gateway's order tracker) to start the next day, in replay as in real time.
    DayClosed {
        business_date: String,
    },
}

/// One execution between an incoming order and one resting order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trade {
    pub trade_id: TradeId,
    pub symbol: String,
    /// Always the resting order's price: whoever was in the book first sets the price.
    pub price: PriceCents,
    pub qty: Qty,
    /// The side of the incoming order, the one that removed liquidity.
    pub aggressor_side: Side,
    pub aggressor_order_id: OrderId,
    pub aggressor_participant: String,
    pub resting_order_id: OrderId,
    pub resting_participant: String,
}

impl Trade {
    /// The buying participant and order, whichever of the two was the aggressor.
    pub fn buyer(&self) -> (&str, OrderId) {
        match self.aggressor_side {
            Side::Buy => (&self.aggressor_participant, self.aggressor_order_id),
            Side::Sell => (&self.resting_participant, self.resting_order_id),
        }
    }

    /// The selling participant and order.
    pub fn seller(&self) -> (&str, OrderId) {
        match self.aggressor_side {
            Side::Buy => (&self.resting_participant, self.resting_order_id),
            Side::Sell => (&self.aggressor_participant, self.aggressor_order_id),
        }
    }
}

/// The new state of one price level after a command.
///
/// `qty` is the level's new **total**, not a difference. An absolute value can be applied
/// twice or out of order and still leave a subscriber with the right answer; a difference
/// cannot. `qty == 0` means the level is gone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookDelta {
    pub symbol: String,
    pub side: Side,
    pub price: PriceCents,
    pub qty: Qty,
    pub order_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RejectReason {
    /// Quantity was zero or negative.
    InvalidQuantity,
    /// A limit price was zero or negative.
    InvalidPrice,
    /// No resting order with that id belongs to the requester. Deliberately the same answer
    /// whether the order never existed, already finished, or belongs to someone else, so a
    /// participant cannot probe for other participants' order ids.
    UnknownOrder,
}

impl fmt::Display for RejectReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            RejectReason::InvalidQuantity => "quantity must be positive",
            RejectReason::InvalidPrice => "limit price must be positive",
            RejectReason::UnknownOrder => "no resting order with that id is yours",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CancelReason {
    /// The owner asked for it.
    Requested,
    /// Immediate-or-cancel: the part that could not trade straight away.
    ImmediateOrCancel,
    /// Fill-or-kill: not enough liquidity for the whole order, so none of it traded.
    FillOrKill,
    /// A market order ran out of book to trade against.
    NoLiquidity,
    /// The next order in line belonged to the same participant, and a participant may not
    /// trade with itself. Policy: cancel the *incoming* order's remainder and leave the
    /// resting order where it is.
    SelfTradePrevention,
    /// A `Day` order still resting when the business day closed.
    Expired,
}

impl fmt::Display for CancelReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            CancelReason::Requested => "cancel requested",
            CancelReason::ImmediateOrCancel => "IOC remainder",
            CancelReason::FillOrKill => "FOK: not enough liquidity, nothing traded",
            CancelReason::NoLiquidity => "market order ran out of book",
            CancelReason::SelfTradePrevention => "self-trade prevention",
            CancelReason::Expired => "day order expired at end of day",
        })
    }
}
