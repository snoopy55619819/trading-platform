//! The anonymisation boundary.
//!
//! An engine [`Trade`] names both participants and both order ids, because the gateway needs
//! them to write execution reports. None of that may reach the public feed. This file is the
//! only place an engine event is turned into something public, and everything downstream of
//! it only ever sees a [`PublicEvent`], which has no field that could hold an identity.

use matching_engine::{BookDelta, Event, PriceCents, Qty, Side, Trade, TradeId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublicEvent {
    /// One price level's new total. `qty == 0` means the level is gone.
    Level {
        symbol: String,
        side: Side,
        price: PriceCents,
        qty: Qty,
        order_count: usize,
    },
    /// A match, with no record of who was on either side.
    Trade {
        trade_id: TradeId,
        symbol: String,
        price: PriceCents,
        qty: Qty,
        aggressor_side: Side,
    },
}

impl PublicEvent {
    /// The public part of an engine event, if it has one. Order acknowledgements, rejections
    /// and cancels are private: the book change they cause arrives as its own `BookDelta`.
    pub fn from_event(event: &Event) -> Option<PublicEvent> {
        match event {
            Event::BookDelta(BookDelta {
                symbol,
                side,
                price,
                qty,
                order_count,
            }) => Some(PublicEvent::Level {
                symbol: symbol.clone(),
                side: *side,
                price: *price,
                qty: *qty,
                order_count: *order_count,
            }),
            // Every field is named, with no `..`, so adding a field to the engine's Trade is
            // a compile error here until someone decides whether it is public.
            Event::Trade(Trade {
                trade_id,
                symbol,
                price,
                qty,
                aggressor_side,
                aggressor_order_id: _,
                aggressor_participant: _,
                resting_order_id: _,
                resting_participant: _,
            }) => Some(PublicEvent::Trade {
                trade_id: *trade_id,
                symbol: symbol.clone(),
                price: *price,
                qty: *qty,
                aggressor_side: *aggressor_side,
            }),
            Event::Accepted { .. }
            | Event::Rejected { .. }
            | Event::Canceled { .. }
            | Event::CancelRejected { .. } => None,
        }
    }

    pub fn symbol(&self) -> &str {
        match self {
            PublicEvent::Level { symbol, .. } | PublicEvent::Trade { symbol, .. } => symbol,
        }
    }
}
