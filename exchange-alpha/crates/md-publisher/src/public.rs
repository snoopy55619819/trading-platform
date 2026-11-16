//! The anonymisation boundary.
//!
//! An engine [`Trade`] names both participants and both order ids, because the gateway needs
//! them to write execution reports. None of that may reach the public feed. This file is the
//! only place an engine event is turned into something public, and everything downstream of
//! it only ever sees a [`PublicEvent`], which has no field that could hold an identity.

use matching_engine::{BookDelta, Event, PriceCents, Qty, Side, Trade, TradeId};

#[derive(Debug, Clone, PartialEq)]
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
    /// How busy the venue was over the last interval (ADR 0016): totals across every
    /// session, so nothing in it tells one participant from another. Sent to every
    /// connection, with no sequence number.
    Stats(VenueActivity),
}

/// The venue's activity, as `VenueStats` publishes it (spec 1.4.0). Rates are per second
/// over `interval_ms`; the `_today` totals are since the business day began.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VenueActivity {
    pub interval_ms: u32,
    pub business_date: String,
    pub transactions_per_sec: f64,
    pub new_orders_per_sec: f64,
    pub cancels_per_sec: f64,
    pub rejects_per_sec: f64,
    pub trades_per_sec: f64,
    pub shares_per_sec: f64,
    pub notional_cents_per_sec: f64,
    pub fix_in_per_sec: f64,
    pub fix_out_per_sec: f64,
    pub feed_messages_per_sec: f64,
    pub answer_p50_us: u32,
    pub answer_p99_us: u32,
    pub open_orders: u32,
    pub sessions: u32,
    pub transactions_today: u64,
    pub trades_today: u64,
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
            | Event::CancelRejected { .. }
            | Event::DayClosed { .. } => None,
        }
    }

    /// The symbol it is about; empty for venue-wide stats.
    pub fn symbol(&self) -> &str {
        match self {
            PublicEvent::Level { symbol, .. } | PublicEvent::Trade { symbol, .. } => symbol,
            PublicEvent::Stats(_) => "",
        }
    }
}
