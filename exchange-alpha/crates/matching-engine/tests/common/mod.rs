//! Shared test helpers: a single-symbol market with terse order builders.
#![allow(dead_code)] // each test file uses a different subset

use matching_engine::*;

pub const SYMBOL: &str = "ACME";

#[derive(Default)]
pub struct Market {
    pub engine: Engine,
    client_ids: u64,
}

impl Market {
    /// A good-till-cancel limit order. `cents` is the price in cents.
    pub fn limit(&mut self, who: &str, side: Side, qty: i64, cents: i64) -> Vec<Event> {
        self.limit_tif(who, side, qty, cents, TimeInForce::Gtc)
    }

    pub fn limit_tif(
        &mut self,
        who: &str,
        side: Side,
        qty: i64,
        cents: i64,
        time_in_force: TimeInForce,
    ) -> Vec<Event> {
        let order_type = OrderType::Limit {
            price: PriceCents(cents),
        };
        self.new_order(who, side, qty, order_type, time_in_force)
    }

    pub fn market(&mut self, who: &str, side: Side, qty: i64) -> Vec<Event> {
        self.new_order(who, side, qty, OrderType::Market, TimeInForce::Ioc)
    }

    pub fn cancel(&mut self, who: &str, order_id: u64) -> Vec<Event> {
        self.engine.apply(Command::Cancel(CancelOrder {
            participant: who.to_string(),
            order_id: OrderId(order_id),
        }))
    }

    pub fn new_order(
        &mut self,
        who: &str,
        side: Side,
        qty: i64,
        order_type: OrderType,
        time_in_force: TimeInForce,
    ) -> Vec<Event> {
        self.client_ids += 1;
        self.engine.apply(Command::New(NewOrder {
            client_order_id: format!("c{}", self.client_ids),
            participant: who.to_string(),
            symbol: SYMBOL.to_string(),
            side,
            order_type,
            time_in_force,
            qty: Qty(qty),
        }))
    }

    pub fn book(&self) -> &OrderBook {
        self.engine
            .book(SYMBOL)
            .expect("book exists once an order was sent")
    }

    /// (price in cents, total qty) for each level on one side, best first.
    pub fn levels(&self, side: Side) -> Vec<(i64, i64)> {
        self.book()
            .depth(side)
            .map(|level| (level.price.0, level.qty.0))
            .collect()
    }
}

pub fn trades(events: &[Event]) -> Vec<&Trade> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Trade(trade) => Some(trade),
            _ => None,
        })
        .collect()
}

/// (seller, price in cents, qty) for each trade, which is what most tests care about.
pub fn fills(events: &[Event]) -> Vec<(&str, i64, i64)> {
    trades(events)
        .into_iter()
        .map(|trade| (trade.seller().0, trade.price.0, trade.qty.0))
        .collect()
}

pub fn cancel_reason(events: &[Event]) -> Option<(CancelReason, i64)> {
    events.iter().find_map(|event| match event {
        Event::Canceled {
            reason, remaining, ..
        } => Some((*reason, remaining.0)),
        _ => None,
    })
}
