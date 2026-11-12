//! What the engine accepts.
//!
//! Commands are the engine's only input, and they are exactly what the journal records. The
//! engine is deterministic: the same commands in the same order always produce the same book
//! and the same events. That is the property replay depends on, so nothing that varies
//! between runs (wall-clock time, randomness, hash order) may influence matching.

use serde::{Deserialize, Serialize};

use crate::types::{OrderId, OrderType, Qty, Side, TimeInForce};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Command {
    New(NewOrder),
    Cancel(CancelOrder),
    EndOfDay(EndOfDay),
}

/// An incoming order. By the time it reaches the engine the gateway has already checked the
/// symbol, tick size, lot size, price band and duplicate client order ids. The engine checks
/// only what it needs in order to match safely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewOrder {
    /// The client's own id for the order (FIX `ClOrdID`). Echoed back, never interpreted.
    pub client_order_id: String,
    /// Who sent it. Used for self-trade prevention and to authorise cancels.
    pub participant: String,
    pub symbol: String,
    pub side: Side,
    pub order_type: OrderType,
    pub time_in_force: TimeInForce,
    pub qty: Qty,
}

/// A request to cancel a resting order. Only the participant that placed it may cancel it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelOrder {
    pub participant: String,
    pub order_id: OrderId,
}

/// The close of a business day: every resting `Day` order expires; `Gtc` orders stay.
///
/// A command like any other, so it is journaled and replay reproduces the close exactly.
/// The engine has no clock: the gateway decides when the day ends and sends this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndOfDay {
    /// The business day that is closing, `YYYY-MM-DD`. Recorded for whoever reads the
    /// journal; the engine does not interpret it.
    pub business_date: String,
}
