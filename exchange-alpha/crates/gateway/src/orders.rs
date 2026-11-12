//! Translation between FIX and the matching engine, and the order state that requires.
//!
//! The engine speaks in commands and events and keeps only what matching needs. FIX needs
//! more: every execution report carries the order's running totals (`CumQty`, `LeavesQty`,
//! `AvgPx`), and clients refer to orders by their own `ClOrdID`. The `OrderTracker` keeps that
//! state, derived purely from engine events. Because it is derived from events, replaying the
//! journal on restart rebuilds it exactly, with nothing else to persist.
//!
//! Inbound, it validates orders against the venue's rules (symbol, tick, lot, price band,
//! duplicate ids) before anything reaches the engine, and every rejection names a specific
//! `OrdRejReason`.
//!
//! Outbound, it decides who sees what. **An execution report goes only to the session that
//! owns the order**: a trade produces two reports, one to each side, and neither learns who
//! the other was.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use fix_core::Message;
use fix_core::decimal::{format_scaled, parse_scaled};
use fix_core::tags::{msg_type, *};
use matching_engine::{
    CancelOrder, CancelReason, Command, Event, NewOrder, OrderId, OrderType, PriceCents, Qty,
    RejectReason, Side, TimeInForce, Trade,
};

use crate::listings::Listings;

/// FIX code values used in reports. Named here so the logic below reads as words.
mod code {
    pub const EXEC_NEW: &str = "0";
    pub const EXEC_CANCELED: &str = "4";
    pub const EXEC_EXPIRED: &str = "C";
    pub const EXEC_REJECTED: &str = "8";
    pub const EXEC_TRADE: &str = "F";

    pub const STATUS_NEW: &str = "0";
    pub const STATUS_PARTIALLY_FILLED: &str = "1";
    pub const STATUS_FILLED: &str = "2";
    pub const STATUS_CANCELED: &str = "4";
    pub const STATUS_EXPIRED: &str = "C";
    pub const STATUS_REJECTED: &str = "8";

    pub const REJECT_UNKNOWN_SYMBOL: &str = "1";
    pub const REJECT_EXCHANGE_CLOSED: &str = "2";
    pub const REJECT_EXCEEDS_LIMIT: &str = "3";
    pub const REJECT_DUPLICATE_ORDER: &str = "6";
    pub const REJECT_UNSUPPORTED: &str = "11";
    pub const REJECT_INCORRECT_QUANTITY: &str = "13";
    pub const REJECT_OTHER: &str = "99";

    pub const CANCEL_TOO_LATE: &str = "0";
    pub const CANCEL_UNKNOWN_ORDER: &str = "1";
    pub const CANCEL_DUPLICATE_ID: &str = "6";

    pub const LIQUIDITY_ADDED: &str = "1";
    pub const LIQUIDITY_REMOVED: &str = "2";
}

/// A FIX message for one session.
#[derive(Debug, Clone)]
pub struct Report {
    pub comp_id: String,
    pub message: Message,
}

/// What the gateway knows about one live order beyond the engine: enough to write its
/// reports. Kept only while the order can still trade; when it finishes, all that remains is
/// a [`ClientId::Finished`] entry saying how it ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackedOrder {
    comp_id: String,
    account: String,
    client_order_id: String,
    symbol: String,
    side: Side,
    order_type: OrderType,
    time_in_force: TimeInForce,
    qty: i64,
    cum_qty: i64,
    /// Exact traded value in cents. The average price is derived from it, never the reverse.
    notional_cents: i64,
    open: bool,
}

/// How an order ended, which is all a finished order needs to be remembered by: a late
/// cancel request is answered "too late", with this as the order's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Ended {
    Filled,
    Canceled,
    Expired,
}

impl Ended {
    fn status(self) -> &'static str {
        match self {
            Ended::Filled => code::STATUS_FILLED,
            Ended::Canceled => code::STATUS_CANCELED,
            Ended::Expired => code::STATUS_EXPIRED,
        }
    }
}

/// What a session's `ClOrdID` refers to, for the rest of the business day. A `ClOrdID` may
/// be used once a day, so every one used is remembered, but only a live order keeps its
/// full record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientId {
    /// An order that can still trade; its record is in `orders`.
    Live(OrderId),
    /// An order that filled, was cancelled or expired.
    Finished(OrderId, Ended),
    /// Spent on something that never became an order: a rejected order, a cancel request.
    Spent,
}

struct PendingCancel {
    cancel_client_order_id: String,
    orig_client_order_id: String,
}

/// The tracker's state as plain data, sorted, for a snapshot. Two trackers are in the same
/// state exactly when these serialise to the same bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrdersState {
    /// Every live order, by id.
    pub orders: Vec<(OrderId, TrackedOrder)>,
    /// Every (CompID, ClOrdID) used this business day.
    pub used_client_ids: Vec<(String, String)>,
    /// The orders that finished this business day: (CompID, ClOrdID, order, how it ended).
    /// Absent from snapshots written before finished orders were kept this small; those were
    /// all taken at a roll, when nothing has finished yet.
    #[serde(default)]
    pub finished: Vec<(String, String, OrderId, Ended)>,
}

pub struct OrderTracker {
    venue: String,
    /// Live orders only. A finished order's record is dropped: almost every order a market
    /// maker sends is cancelled within seconds, and keeping each one's full record until the
    /// end of the day grew the gateway by about 1.35 KB an order.
    orders: HashMap<OrderId, TrackedOrder>,
    /// Every `ClOrdID` each session used today, by CompID, and what it refers to. A client
    /// names its orders by its own `ClOrdID`, scoped to its session, so one client can never
    /// address another's order, even by guessing its id.
    client_ids: HashMap<String, HashMap<String, ClientId>>,
    pending_cancels: HashMap<OrderId, PendingCancel>,
}

impl OrderTracker {
    pub fn new(listings: &Listings) -> Self {
        OrderTracker {
            venue: listings.venue.clone(),
            orders: HashMap::new(),
            client_ids: HashMap::new(),
            pending_cancels: HashMap::new(),
        }
    }

    /// Rebuilds a tracker from [`state`](Self::state).
    pub fn restore(listings: &Listings, state: OrdersState) -> Self {
        let mut tracker = OrderTracker::new(listings);
        for (comp_id, client_order_id) in state.used_client_ids {
            tracker.set_client_id(&comp_id, &client_order_id, ClientId::Spent);
        }
        for (comp_id, client_order_id, order_id, ended) in state.finished {
            let entry = ClientId::Finished(order_id, ended);
            tracker.set_client_id(&comp_id, &client_order_id, entry);
        }
        for (order_id, order) in state.orders {
            if order.open {
                let entry = ClientId::Live(order_id);
                tracker.set_client_id(&order.comp_id, &order.client_order_id, entry);
                tracker.orders.insert(order_id, order);
            } else {
                // Only in snapshots from before finished orders were dropped.
                let ended = if order.cum_qty == order.qty {
                    Ended::Filled
                } else {
                    Ended::Canceled
                };
                let entry = ClientId::Finished(order_id, ended);
                tracker.set_client_id(&order.comp_id, &order.client_order_id, entry);
            }
        }
        tracker
    }

    /// The state to snapshot. Taken between commands, when no cancel is ever pending: a
    /// cancel request is answered by the very command it becomes.
    pub fn state(&self) -> OrdersState {
        debug_assert!(
            self.pending_cancels.is_empty(),
            "snapshot taken mid-command"
        );
        let mut orders: Vec<_> = self
            .orders
            .iter()
            .map(|(id, order)| (*id, order.clone()))
            .collect();
        orders.sort_by_key(|(id, _)| *id);
        let mut used_client_ids = Vec::new();
        let mut finished = Vec::new();
        for (comp_id, ids) in &self.client_ids {
            for (client_order_id, entry) in ids {
                used_client_ids.push((comp_id.clone(), client_order_id.clone()));
                if let ClientId::Finished(order_id, ended) = entry {
                    finished.push((comp_id.clone(), client_order_id.clone(), *order_id, *ended));
                }
            }
        }
        used_client_ids.sort();
        finished.sort_by_key(|(_, _, order_id, _)| *order_id);
        OrdersState {
            orders,
            used_client_ids,
            finished,
        }
    }

    /// A new business day: forget every finished order and every used `ClOrdID`, keeping
    /// only the orders still resting (good-till-cancelled ones) and their ids. A `ClOrdID` is
    /// unique per session and business day, so the next day may use any other id again.
    fn start_next_day(&mut self) {
        for ids in self.client_ids.values_mut() {
            ids.retain(|_, entry| matches!(entry, ClientId::Live(_)));
        }
        self.client_ids.retain(|_, ids| !ids.is_empty());
    }

    pub fn open_order_count(&self) -> usize {
        self.orders.len()
    }

    fn client_id(&self, comp_id: &str, client_order_id: &str) -> Option<ClientId> {
        self.client_ids.get(comp_id)?.get(client_order_id).copied()
    }

    fn set_client_id(&mut self, comp_id: &str, client_order_id: &str, entry: ClientId) {
        self.client_ids
            .entry(comp_id.to_string())
            .or_default()
            .insert(client_order_id.to_string(), entry);
    }

    /// Records a `ClOrdID` as used. False if this session has already used it today.
    fn spend(&mut self, comp_id: &str, client_order_id: &str) -> bool {
        if self.client_id(comp_id, client_order_id).is_some() {
            return false;
        }
        self.set_client_id(comp_id, client_order_id, ClientId::Spent);
        true
    }

    /// The order can no longer trade: drop its record, keep how it ended.
    fn finish(&mut self, order_id: OrderId, ended: Ended) {
        if let Some(order) = self.orders.remove(&order_id) {
            let entry = ClientId::Finished(order_id, ended);
            self.set_client_id(&order.comp_id, &order.client_order_id, entry);
        }
    }

    /// Validates a `NewOrderSingle` and turns it into an engine command, or into the
    /// execution report that rejects it.
    ///
    /// The message has already passed dictionary validation, so required fields are present
    /// and well formed. What is checked here is whether the venue will accept the order.
    pub fn new_order_single(
        &mut self,
        comp_id: &str,
        message: &Message,
        listings: &Listings,
    ) -> Result<Command, Report> {
        let field = |tag| message.get(tag).unwrap_or_default();
        let client_order_id = field(CL_ORD_ID);
        let reject = |reason: &str, text: String| Report {
            comp_id: comp_id.to_string(),
            message: rejection(message, reason, &text),
        };

        if !self.spend(comp_id, client_order_id) {
            return Err(reject(
                code::REJECT_DUPLICATE_ORDER,
                format!("ClOrdID {client_order_id} has already been used"),
            ));
        }

        let Some(symbol) = listings.symbol(field(SYMBOL)) else {
            return Err(reject(
                code::REJECT_UNKNOWN_SYMBOL,
                format!("{} is not listed on {}", field(SYMBOL), self.venue),
            ));
        };
        if !symbol.is_active() {
            return Err(reject(
                code::REJECT_EXCHANGE_CLOSED,
                format!("{} is {}", symbol.ticker, symbol.status),
            ));
        }
        if message
            .get(SECURITY_EXCHANGE)
            .is_some_and(|ex| ex != self.venue)
        {
            return Err(reject(
                code::REJECT_OTHER,
                format!("this is {}; route the order to its venue", self.venue),
            ));
        }
        if message
            .get(CURRENCY)
            .is_some_and(|ccy| ccy != symbol.currency)
        {
            return Err(reject(
                code::REJECT_OTHER,
                format!("{} trades in {}", symbol.ticker, symbol.currency),
            ));
        }

        let qty = match parse_scaled(field(ORDER_QTY), 0) {
            Ok(qty) if qty > 0 => qty,
            _ => {
                return Err(reject(
                    code::REJECT_INCORRECT_QUANTITY,
                    "quantity must be a positive whole number of shares".into(),
                ));
            }
        };
        if qty % symbol.lot_size != 0 {
            return Err(reject(
                code::REJECT_INCORRECT_QUANTITY,
                format!(
                    "quantity must be a multiple of the lot size {}",
                    symbol.lot_size
                ),
            ));
        }

        let order_type = match (field(ORD_TYPE), message.get(PRICE)) {
            ("1", None) => OrderType::Market,
            ("1", Some(_)) => {
                return Err(reject(
                    code::REJECT_UNSUPPORTED,
                    "a market order must not have a Price".into(),
                ));
            }
            (_, None) => {
                return Err(reject(
                    code::REJECT_UNSUPPORTED,
                    "a limit order needs a Price".into(),
                ));
            }
            (_, Some(text)) => {
                let price = match parse_scaled(text, 2) {
                    Ok(cents) if cents > 0 => cents,
                    _ => {
                        return Err(reject(
                            code::REJECT_UNSUPPORTED,
                            "price must be positive, in whole cents".into(),
                        ));
                    }
                };
                if price % symbol.tick_size_cents != 0 {
                    return Err(reject(
                        code::REJECT_UNSUPPORTED,
                        format!(
                            "{} trades in increments of {}",
                            symbol.ticker,
                            format_scaled(symbol.tick_size_cents, 2)
                        ),
                    ));
                }
                if !symbol.within_band(price) {
                    return Err(reject(
                        code::REJECT_EXCEEDS_LIMIT,
                        format!(
                            "price is more than {}% from the reference price {}",
                            symbol.price_band_pct,
                            format_scaled(symbol.reference_price_cents, 2)
                        ),
                    ));
                }
                OrderType::Limit {
                    price: PriceCents(price),
                }
            }
        };

        Ok(Command::New(NewOrder {
            client_order_id: client_order_id.to_string(),
            participant: participant(comp_id, field(ACCOUNT)),
            symbol: symbol.ticker.clone(),
            side: side_from_fix(field(SIDE)),
            order_type,
            // FIX says an absent TimeInForce means Day.
            time_in_force: tif_from_fix(message.get(TIME_IN_FORCE).unwrap_or("0")),
            qty: Qty(qty),
        }))
    }

    /// Turns an `OrderCancelRequest` into an engine command, or into the
    /// `OrderCancelReject` that refuses it.
    pub fn cancel_request(&mut self, comp_id: &str, message: &Message) -> Result<Command, Report> {
        let field = |tag| message.get(tag).unwrap_or_default();
        let cancel_id = field(CL_ORD_ID);
        let orig_id = field(ORIG_CL_ORD_ID);
        let session = comp_id.to_string();
        let target = self.client_id(comp_id, orig_id);
        let order_id = match target {
            Some(ClientId::Live(id) | ClientId::Finished(id, _)) => Some(id),
            Some(ClientId::Spent) | None => None,
        };
        let wire_order_id = order_id.map(|id| self.wire_id(id));
        let reject = |status: &str, reason: &str, text: &str| Report {
            comp_id: session.clone(),
            message: cancel_reject(message, wire_order_id.clone(), status, reason, text),
        };

        if !self.spend(comp_id, cancel_id) {
            return Err(reject(
                code::STATUS_REJECTED,
                code::CANCEL_DUPLICATE_ID,
                "ClOrdID has already been used",
            ));
        }
        let order_id = match target {
            Some(ClientId::Live(order_id)) => order_id,
            Some(ClientId::Finished(_, ended)) => {
                return Err(reject(
                    ended.status(),
                    code::CANCEL_TOO_LATE,
                    "the order is already filled or cancelled",
                ));
            }
            Some(ClientId::Spent) | None => {
                return Err(reject(
                    code::STATUS_REJECTED,
                    code::CANCEL_UNKNOWN_ORDER,
                    "no order of yours has that OrigClOrdID",
                ));
            }
        };
        let order = &self.orders[&order_id];
        let matches = order.account == field(ACCOUNT)
            && order.symbol == field(SYMBOL)
            && order.side == side_from_fix(field(SIDE))
            && message
                .get(ORDER_ID)
                .is_none_or(|id| Some(id) == wire_order_id.as_deref());
        if !matches {
            return Err(reject(
                status_of(order),
                code::CANCEL_UNKNOWN_ORDER,
                "Account, Symbol, Side or OrderID do not match the order",
            ));
        }
        if !order.open {
            return Err(reject(
                status_of(order),
                code::CANCEL_TOO_LATE,
                "the order is already filled or cancelled",
            ));
        }

        let participant = participant(comp_id, &order.account);
        self.pending_cancels.insert(
            order_id,
            PendingCancel {
                cancel_client_order_id: cancel_id.to_string(),
                orig_client_order_id: orig_id.to_string(),
            },
        );
        Ok(Command::Cancel(CancelOrder {
            participant,
            order_id,
        }))
    }

    /// Updates order state from one engine event and returns the FIX messages it produces.
    ///
    /// Runs for live events and for journal replay alike; during replay the reports are
    /// simply dropped, since they were sent the first time.
    pub fn apply(&mut self, event: &Event, listings: &Listings) -> Vec<Report> {
        match event {
            Event::Accepted {
                order_id,
                client_order_id,
                participant,
                symbol,
                side,
                order_type,
                time_in_force,
                qty,
            } => {
                let (comp_id, account) = split_participant(participant);
                self.set_client_id(&comp_id, client_order_id, ClientId::Live(*order_id));
                let order = TrackedOrder {
                    comp_id,
                    account,
                    client_order_id: client_order_id.clone(),
                    symbol: symbol.clone(),
                    side: *side,
                    order_type: *order_type,
                    time_in_force: *time_in_force,
                    qty: qty.0,
                    cum_qty: 0,
                    notional_cents: 0,
                    open: true,
                };
                let report = self.report(*order_id, &order, code::EXEC_NEW, code::STATUS_NEW);
                self.orders.insert(*order_id, order);
                vec![report]
            }
            Event::Trade(trade) => vec![
                self.fill(trade, trade.aggressor_order_id, false, listings),
                self.fill(trade, trade.resting_order_id, true, listings),
            ],
            Event::Canceled {
                order_id, reason, ..
            } => {
                let pending = self.pending_cancels.remove(order_id);
                let Some(order) = self.orders.get_mut(order_id) else {
                    return Vec::new();
                };
                order.open = false;
                let order = order.clone();
                let (exec_type, status, ended) = match reason {
                    CancelReason::Expired => {
                        (code::EXEC_EXPIRED, code::STATUS_EXPIRED, Ended::Expired)
                    }
                    _ => (code::EXEC_CANCELED, code::STATUS_CANCELED, Ended::Canceled),
                };
                let mut report = self.report(*order_id, &order, exec_type, status);
                self.finish(*order_id, ended);
                if let Some(pending) = pending.filter(|_| *reason == CancelReason::Requested) {
                    // The report answers the cancel request, so it carries that request's id.
                    report
                        .message
                        .set(CL_ORD_ID, pending.cancel_client_order_id);
                }
                report.message.set(TEXT, reason.to_string());
                vec![report]
            }
            Event::CancelRejected {
                order_id,
                participant,
                reason,
            } => {
                // Rare: the gateway checks ownership and openness first, so this only happens
                // if the order finished between that check and the engine. Answer it anyway.
                let (comp_id, _) = split_participant(participant);
                let Some(pending) = self.pending_cancels.remove(order_id) else {
                    return Vec::new();
                };
                let status = match self.orders.get(order_id) {
                    Some(order) => status_of(order),
                    None => match self.client_id(&comp_id, &pending.orig_client_order_id) {
                        Some(ClientId::Finished(_, ended)) => ended.status(),
                        _ => code::STATUS_REJECTED,
                    },
                };
                let why = match reason {
                    RejectReason::UnknownOrder => code::CANCEL_TOO_LATE,
                    _ => code::CANCEL_UNKNOWN_ORDER,
                };
                let message = Message::new(msg_type::ORDER_CANCEL_REJECT)
                    .with(ORDER_ID, self.wire_id(*order_id))
                    .with(CL_ORD_ID, pending.cancel_client_order_id)
                    .with(ORIG_CL_ORD_ID, pending.orig_client_order_id)
                    .with(ORD_STATUS, status)
                    .with(CXL_REJ_RESPONSE_TO, "1")
                    .with(CXL_REJ_REASON, why)
                    .with(TEXT, reason.to_string());
                vec![Report { comp_id, message }]
            }
            Event::DayClosed { .. } => {
                self.start_next_day();
                Vec::new()
            }
            Event::Rejected { .. } => {
                // Unreachable in practice: the engine only rejects a non-positive quantity or
                // price, and the gateway refuses both before submitting.
                tracing::error!(?event, "engine rejected an order the gateway accepted");
                Vec::new()
            }
            // The public plane. Published by md-publisher at milestone 3, not by the gateway.
            Event::BookDelta(_) => Vec::new(),
        }
    }

    fn fill(
        &mut self,
        trade: &Trade,
        order_id: OrderId,
        added_liquidity: bool,
        listings: &Listings,
    ) -> Report {
        let fill_notional = trade.qty.0 * trade.price.0;
        let order = self
            .orders
            .get_mut(&order_id)
            .expect("an order trades only after it was accepted");
        order.cum_qty += trade.qty.0;
        order.notional_cents += fill_notional;
        if order.cum_qty == order.qty {
            order.open = false;
        }
        let order = order.clone();

        let mut report = self.report(order_id, &order, code::EXEC_TRADE, status_of(&order));
        if !order.open {
            self.finish(order_id, Ended::Filled);
        }
        let fee = listings.fee_cents(fill_notional, added_liquidity);
        let liquidity = if added_liquidity {
            code::LIQUIDITY_ADDED
        } else {
            code::LIQUIDITY_REMOVED
        };
        report.message.set(LAST_QTY, trade.qty.0.to_string());
        report.message.set(LAST_PX, format_scaled(trade.price.0, 2));
        report.message.set(LAST_LIQUIDITY_IND, liquidity);
        report.message.set(COMMISSION, format_scaled(fee, 2));
        report.message.set(COMM_TYPE, "3"); // absolute amount
        report
    }

    /// An execution report for one order, carrying its running totals. `ExecID` and
    /// `TransactTime` are added by the caller when it sends.
    fn report(
        &self,
        order_id: OrderId,
        order: &TrackedOrder,
        exec_type: &str,
        status: &str,
    ) -> Report {
        let leaves = if order.open {
            order.qty - order.cum_qty
        } else {
            0
        };
        let mut message = Message::new(msg_type::EXECUTION_REPORT)
            .with(ORDER_ID, self.wire_id(order_id))
            .with(CL_ORD_ID, order.client_order_id.clone())
            .with(EXEC_TYPE, exec_type)
            .with(ORD_STATUS, status)
            .with(ACCOUNT, order.account.clone())
            .with(SYMBOL, order.symbol.clone())
            .with(SECURITY_EXCHANGE, self.venue.clone())
            .with(SIDE, side_to_fix(order.side))
            .with(ORDER_QTY, order.qty.to_string())
            .with(TIME_IN_FORCE, tif_to_fix(order.time_in_force))
            .with(LEAVES_QTY, leaves.to_string())
            .with(CUM_QTY, order.cum_qty.to_string())
            .with(AVG_PX, average_price(order.notional_cents, order.cum_qty))
            .with(CURRENCY, "USD");
        match order.order_type {
            OrderType::Limit { price } => {
                message.set(ORD_TYPE, "2");
                message.set(PRICE, format_scaled(price.0, 2));
            }
            OrderType::Market => message.set(ORD_TYPE, "1"),
        }
        Report {
            comp_id: order.comp_id.clone(),
            message,
        }
    }

    /// Order ids on the wire carry the venue: `ALPHA-17`.
    fn wire_id(&self, order_id: OrderId) -> String {
        format!("{}-{}", self.venue, order_id)
    }
}

/// The engine identifies whoever owns an order as one string. Using the session *and* the
/// account means self-trade prevention applies per account, so two different clients of the
/// same broker may still trade with each other.
fn participant(comp_id: &str, account: &str) -> String {
    format!("{comp_id}/{account}")
}

fn split_participant(participant: &str) -> (String, String) {
    let (comp_id, account) = participant.split_once('/').unwrap_or((participant, ""));
    (comp_id.to_string(), account.to_string())
}

fn status_of(order: &TrackedOrder) -> &'static str {
    match (order.open, order.cum_qty) {
        (_, cum) if cum == order.qty => code::STATUS_FILLED,
        (false, _) => code::STATUS_CANCELED,
        (true, 0) => code::STATUS_NEW,
        (true, _) => code::STATUS_PARTIALLY_FILLED,
    }
}

/// Exact average price to four decimal places, by integer division: cents times 100 over
/// shares is ten-thousandths of a dollar.
fn average_price(notional_cents: i64, cum_qty: i64) -> String {
    if cum_qty == 0 {
        return "0".into();
    }
    format_scaled(notional_cents * 100 / cum_qty, 4)
}

/// An execution report rejecting a `NewOrderSingle` before it reached the engine.
fn rejection(order: &Message, reason: &str, text: &str) -> Message {
    let mut message = Message::new(msg_type::EXECUTION_REPORT)
        .with(ORDER_ID, "NONE")
        .with(EXEC_TYPE, code::EXEC_REJECTED)
        .with(ORD_STATUS, code::STATUS_REJECTED)
        .with(LEAVES_QTY, "0")
        .with(CUM_QTY, "0")
        .with(AVG_PX, "0")
        .with(ORD_REJ_REASON, reason)
        .with(TEXT, text);
    for tag in [
        CL_ORD_ID,
        ACCOUNT,
        SYMBOL,
        SIDE,
        ORDER_QTY,
        ORD_TYPE,
        PRICE,
        TIME_IN_FORCE,
    ] {
        if let Some(value) = order.get(tag) {
            message.set(tag, value);
        }
    }
    message
}

fn cancel_reject(
    request: &Message,
    wire_order_id: Option<String>,
    status: &str,
    reason: &str,
    text: &str,
) -> Message {
    let mut message = Message::new(msg_type::ORDER_CANCEL_REJECT)
        .with(ORDER_ID, wire_order_id.unwrap_or_else(|| "NONE".into()))
        .with(CL_ORD_ID, request.get(CL_ORD_ID).unwrap_or_default())
        .with(
            ORIG_CL_ORD_ID,
            request.get(ORIG_CL_ORD_ID).unwrap_or_default(),
        )
        .with(ORD_STATUS, status)
        .with(CXL_REJ_RESPONSE_TO, "1")
        .with(CXL_REJ_REASON, reason)
        .with(TEXT, text);
    if let Some(account) = request.get(ACCOUNT) {
        message.set(ACCOUNT, account);
    }
    message
}

fn side_from_fix(code: &str) -> Side {
    if code == "2" { Side::Sell } else { Side::Buy }
}

fn side_to_fix(side: Side) -> &'static str {
    match side {
        Side::Buy => "1",
        Side::Sell => "2",
    }
}

fn tif_from_fix(code: &str) -> TimeInForce {
    match code {
        "1" => TimeInForce::Gtc,
        "3" => TimeInForce::Ioc,
        "4" => TimeInForce::Fok,
        _ => TimeInForce::Day,
    }
}

fn tif_to_fix(tif: TimeInForce) -> &'static str {
    match tif {
        TimeInForce::Day => "0",
        TimeInForce::Gtc => "1",
        TimeInForce::Ioc => "3",
        TimeInForce::Fok => "4",
    }
}
