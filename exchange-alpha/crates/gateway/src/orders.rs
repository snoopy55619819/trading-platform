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

use std::collections::{HashMap, VecDeque};

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

/// What a session's `ClOrdID` refers to. A live order's id is remembered while it lives;
/// a finished or spent one for as long as it is among the session's latest
/// `client_order_id_window` (ADR 0015). Only a live order keeps its full record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientId {
    /// An order that can still trade; its record is in `orders`.
    Live(OrderId),
    /// An order that filled, was cancelled or expired.
    Finished(OrderId, Ended),
    /// Spent on something that never became an order: a rejected order, a cancel request.
    Spent,
}

impl ClientId {
    /// Packed into one `u64`: the order number shifted up three bits, and what the entry
    /// is in the low three. With the key as two `u64`s, a map slot is 24 bytes; `ClientKey`
    /// and this enum as they are would be 32, because a `u128` is aligned on 16 bytes
    /// (ADR 0011, measured: 102 MB at the peak of a 1.5-million-order day, against 212 MB
    /// with the ids as strings).
    fn pack(self) -> u64 {
        let (order_id, tag) = match self {
            ClientId::Spent => (0, 0),
            ClientId::Live(id) => (id.0, 1),
            ClientId::Finished(id, Ended::Filled) => (id.0, 2),
            ClientId::Finished(id, Ended::Canceled) => (id.0, 3),
            ClientId::Finished(id, Ended::Expired) => (id.0, 4),
        };
        debug_assert!(order_id < 1 << 61, "order ids fit in 61 bits");
        (order_id << 3) | tag
    }

    fn unpack(slot: u64) -> ClientId {
        let id = OrderId(slot >> 3);
        match slot & 0b111 {
            1 => ClientId::Live(id),
            2 => ClientId::Finished(id, Ended::Filled),
            3 => ClientId::Finished(id, Ended::Canceled),
            4 => ClientId::Finished(id, Ended::Expired),
            _ => ClientId::Spent,
        }
    }
}

/// A [`ClientKey`] as a map key: two `u64`s, so it is aligned on 8 bytes, not 16.
type MapKey = [u64; 2];

fn map_key(key: ClientKey) -> MapKey {
    [key as u64, (key >> 64) as u64]
}

fn from_map_key(key: &MapKey) -> ClientKey {
    u128::from(key[0]) | (u128::from(key[1]) << 64)
}

struct PendingCancel {
    cancel_client_order_id: String,
    orig_client_order_id: String,
}

/// A `ClOrdID` as the tracker remembers it: a 128-bit hash, not the string (ADR 0011). With
/// its entry packed beside it, a map slot is 24 bytes, against about 40 plus the string's own
/// allocation for the id as a `String`. FNV-1a, because it is fixed and published: the same id gives the same key on
/// every run and every version, which snapshots rely on. Keys are per session, so a collision
/// (about one in 10^21 a day at a billion orders) could only ever touch one client's own ids.
pub type ClientKey = u128;

/// FNV-1a, 128 bits.
pub fn client_key(client_order_id: &str) -> ClientKey {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013b;
    let mut hash = OFFSET;
    for byte in client_order_id.as_bytes() {
        hash ^= u128::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// A key as it is written in a snapshot: 32 hex digits.
fn key_text(key: ClientKey) -> String {
    format!("{key:032x}")
}

fn key_from_text(text: &str) -> ClientKey {
    ClientKey::from_str_radix(text, 16)
        .unwrap_or_else(|_| panic!("snapshot: bad ClOrdID key {text:?}"))
}

/// The tracker's state as plain data, sorted, for a snapshot. Two trackers are in the same
/// state exactly when these serialise to the same bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrdersState {
    /// Every live order, by id.
    pub orders: Vec<(OrderId, TrackedOrder)>,
    /// The ClOrdIDs each session still remembers, as (CompID, key in hex): its finished and
    /// spent ones in the order they stopped being live, oldest first (the window evicts
    /// from the front, so the order matters; ADR 0015), then its live ones.
    #[serde(default)]
    pub used_client_keys: Vec<(String, String)>,
    /// Of those, the orders that finished: (CompID, key in hex, order, how it ended).
    #[serde(default)]
    pub finished_keys: Vec<(String, String, OrderId, Ended)>,
    /// Read from snapshots written before ADR 0011, which named ids by their strings; never
    /// written now.
    #[serde(default, skip_serializing)]
    pub used_client_ids: Vec<(String, String)>,
    /// Likewise, from before ADR 0011.
    #[serde(default, skip_serializing)]
    pub finished: Vec<(String, String, OrderId, Ended)>,
}

pub struct OrderTracker {
    venue: String,
    /// Live orders only. A finished order's record is dropped: almost every order a market
    /// maker sends is cancelled within seconds, and keeping each one's full record until the
    /// end of the day grew the gateway by about 1.35 KB an order.
    orders: HashMap<OrderId, TrackedOrder>,
    /// The `ClOrdID`s each session's orders and requests used, by CompID, and what each refers
    /// to, keyed by its hash ([`client_key`]). A client names its orders by its own `ClOrdID`,
    /// scoped to its session, so one client can never address another's order, even by
    /// guessing its id.
    client_ids: HashMap<String, SessionIds>,
    /// How many finished or spent ids each session remembers (ADR 0015).
    window: usize,
    pending_cancels: HashMap<OrderId, PendingCancel>,
}

/// One session's ids: every one it remembers, and the finished and spent ones in the order
/// they stopped being live, so the oldest can be forgotten once there are more than the
/// window. Each id enters `retired` once: a live order finishes once, and an id is never
/// used twice while remembered.
#[derive(Default)]
struct SessionIds {
    ids: HashMap<MapKey, u64>,
    retired: VecDeque<MapKey>,
}

impl OrderTracker {
    pub fn new(listings: &Listings) -> Self {
        OrderTracker {
            venue: listings.venue.clone(),
            orders: HashMap::new(),
            client_ids: HashMap::new(),
            window: listings.client_order_id_window,
            pending_cancels: HashMap::new(),
        }
    }

    /// Rebuilds a tracker from [`state`](Self::state).
    pub fn restore(listings: &Listings, state: OrdersState) -> Self {
        let mut tracker = OrderTracker::new(listings);
        // Snapshots from before ADR 0011 name ids by their strings: hash them on the way in.
        let used = state
            .used_client_ids
            .iter()
            .map(|(comp_id, id)| (comp_id.clone(), client_key(id)))
            .chain(
                state
                    .used_client_keys
                    .iter()
                    .map(|(comp_id, key)| (comp_id.clone(), key_from_text(key))),
            );
        let used: Vec<(String, ClientKey)> = used.collect();
        let finished = state
            .finished
            .iter()
            .map(|(comp_id, id, order_id, ended)| {
                (comp_id.clone(), client_key(id), *order_id, *ended)
            })
            .chain(
                state
                    .finished_keys
                    .iter()
                    .map(|(comp_id, key, order_id, ended)| {
                        (comp_id.clone(), key_from_text(key), *order_id, *ended)
                    }),
            );
        // Snapshots from before finished orders were dropped list them as closed records.
        let closed =
            state
                .orders
                .iter()
                .filter(|(_, order)| !order.open)
                .map(|(order_id, order)| {
                    let ended = if order.cum_qty == order.qty {
                        Ended::Filled
                    } else {
                        Ended::Canceled
                    };
                    let key = client_key(&order.client_order_id);
                    (order.comp_id.clone(), key, *order_id, ended)
                });
        let finished: HashMap<(String, ClientKey), (OrderId, Ended)> = finished
            .chain(closed.clone())
            .map(|(comp_id, key, order_id, ended)| ((comp_id, key), (order_id, ended)))
            .collect();
        // Every one of those is in the list below; one that is not (none should be) still
        // counts as used.
        let mut used = used;
        for (comp_id, key, _, _) in closed {
            if !used.contains(&(comp_id.clone(), key)) {
                used.push((comp_id, key));
            }
        }
        // Finished and spent ids in the order the snapshot lists them, which is the order
        // they left the live set (ADR 0015); live ones are added from the orders below.
        let live: std::collections::HashSet<(String, ClientKey)> = state
            .orders
            .iter()
            .filter(|(_, order)| order.open)
            .map(|(_, order)| (order.comp_id.clone(), client_key(&order.client_order_id)))
            .collect();
        for (comp_id, key) in used {
            if live.contains(&(comp_id.clone(), key)) {
                continue;
            }
            match finished.get(&(comp_id.clone(), key)) {
                Some((order_id, ended)) => {
                    tracker.set_key(&comp_id, key, ClientId::Finished(*order_id, *ended));
                }
                None => {
                    tracker.set_key(&comp_id, key, ClientId::Spent);
                    tracker.retire(&comp_id, key);
                }
            }
        }
        for (order_id, order) in state.orders.into_iter().filter(|(_, order)| order.open) {
            let entry = ClientId::Live(order_id);
            tracker.set_client_id(&order.comp_id, &order.client_order_id, entry);
            tracker.orders.insert(order_id, order);
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
        let mut used_client_keys = Vec::new();
        let mut finished_keys = Vec::new();
        let mut sessions: Vec<_> = self.client_ids.iter().collect();
        sessions.sort_by(|a, b| a.0.cmp(b.0));
        for (comp_id, session) in sessions {
            // Retired ids oldest first, as the window will evict them; then the live ones,
            // sorted, so the same state always writes the same bytes.
            for key in &session.retired {
                let slot = session.ids[key];
                let text = key_text(from_map_key(key));
                if let ClientId::Finished(order_id, ended) = ClientId::unpack(slot) {
                    finished_keys.push((comp_id.clone(), text.clone(), order_id, ended));
                }
                used_client_keys.push((comp_id.clone(), text));
            }
            let mut live: Vec<String> = session
                .ids
                .iter()
                .filter(|(_, slot)| matches!(ClientId::unpack(**slot), ClientId::Live(_)))
                .map(|(key, _)| key_text(from_map_key(key)))
                .collect();
            live.sort();
            used_client_keys.extend(live.into_iter().map(|key| (comp_id.clone(), key)));
        }
        OrdersState {
            orders,
            used_client_keys,
            finished_keys,
            used_client_ids: Vec::new(),
            finished: Vec::new(),
        }
    }

    /// A new business day: forget every finished order and every used `ClOrdID`, keeping
    /// only the orders still resting (good-till-cancelled ones) and their ids.
    fn start_next_day(&mut self) {
        for session in self.client_ids.values_mut() {
            session
                .ids
                .retain(|_, slot| matches!(ClientId::unpack(*slot), ClientId::Live(_)));
            session.retired.clear();
        }
        self.client_ids.retain(|_, session| !session.ids.is_empty());
    }

    pub fn open_order_count(&self) -> usize {
        self.orders.len()
    }

    fn client_id(&self, comp_id: &str, client_order_id: &str) -> Option<ClientId> {
        self.client_ids
            .get(comp_id)?
            .ids
            .get(&map_key(client_key(client_order_id)))
            .map(|slot| ClientId::unpack(*slot))
    }

    fn set_client_id(&mut self, comp_id: &str, client_order_id: &str, entry: ClientId) {
        self.set_key(comp_id, client_key(client_order_id), entry);
    }

    fn set_key(&mut self, comp_id: &str, key: ClientKey, entry: ClientId) {
        // Sessions are few and long-lived: look up first, so a new CompID string is only
        // allocated once, not on every order.
        if !self.client_ids.contains_key(comp_id) {
            self.client_ids
                .insert(comp_id.to_string(), SessionIds::default());
        }
        let session = self.client_ids.get_mut(comp_id).expect("just inserted");
        session.ids.insert(map_key(key), entry.pack());
        if matches!(entry, ClientId::Finished(..)) {
            self.retire(comp_id, key);
        }
    }

    /// The id is done with for good (its order finished, it was rejected, or it named a
    /// cancel request): remembered from now while it is among the session's latest `window`
    /// such ids, then forgotten, oldest first (ADR 0015). Called once per id.
    fn retire(&mut self, comp_id: &str, key: ClientKey) {
        let Some(session) = self.client_ids.get_mut(comp_id) else {
            return;
        };
        session.retired.push_back(map_key(key));
        while session.retired.len() > self.window {
            let oldest = session.retired.pop_front().expect("longer than the window");
            // Never a live order's: those are not retired. Checked all the same.
            if let Some(slot) = session.ids.get(&oldest)
                && !matches!(ClientId::unpack(*slot), ClientId::Live(_))
            {
                session.ids.remove(&oldest);
            }
        }
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
        let client_order_id = message.get(CL_ORD_ID).unwrap_or_default();
        if !self.spend(comp_id, client_order_id) {
            return Err(Report {
                comp_id: comp_id.to_string(),
                message: rejection(
                    message,
                    code::REJECT_DUPLICATE_ORDER,
                    &format!("ClOrdID {client_order_id} has already been used"),
                ),
            });
        }
        let checked = self.check_new_order(comp_id, message, listings);
        if checked.is_err() {
            // Rejected here, so it will never be live: its id is done with.
            self.retire(comp_id, client_key(client_order_id));
        }
        checked
    }

    /// Everything a new order is checked for after its `ClOrdID`.
    fn check_new_order(
        &self,
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
        // A cancel request's own id never names a live order.
        self.retire(comp_id, client_key(cancel_id));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A tracker remembering only `window` retired ids per session (ADR 0015).
    fn tracker(window: usize) -> (OrderTracker, Listings) {
        let mut listings = Listings::published();
        listings.client_order_id_window = window;
        (OrderTracker::new(&listings), listings)
    }

    fn order(id: &str, symbol: &str) -> Message {
        Message::new(msg_type::NEW_ORDER_SINGLE)
            .with(CL_ORD_ID, id)
            .with(ACCOUNT, "MM-1")
            .with(SYMBOL, symbol)
            .with(SIDE, "2")
            .with(ORDER_QTY, "10")
            .with(ORD_TYPE, "2")
            .with(PRICE, "42.10")
            .with(TIME_IN_FORCE, "1")
    }

    /// Why a new order was rejected (OrdRejReason), or "accepted".
    fn outcome(tracker: &mut OrderTracker, listings: &Listings, id: &str, symbol: &str) -> String {
        match tracker.new_order_single("SIM", &order(id, symbol), listings) {
            Ok(_) => "accepted".to_string(),
            Err(report) => report
                .message
                .get(ORD_REJ_REASON)
                .unwrap_or("?")
                .to_string(),
        }
    }

    #[test]
    fn a_retired_id_is_remembered_while_it_is_among_the_latest_window() {
        let (mut tracker, listings) = tracker(2);
        // Rejected for an unknown symbol (1): spent, and retired.
        assert_eq!(outcome(&mut tracker, &listings, "r1", "NOPE"), "1");
        assert_eq!(outcome(&mut tracker, &listings, "r2", "NOPE"), "1");
        assert_eq!(
            outcome(&mut tracker, &listings, "r1", "ACME"),
            "6",
            "a duplicate"
        );
        assert_eq!(outcome(&mut tracker, &listings, "r3", "NOPE"), "1");
        // r1 is now older than the latest two, so forgotten: usable again.
        assert_eq!(outcome(&mut tracker, &listings, "r1", "ACME"), "accepted");
        assert_eq!(
            outcome(&mut tracker, &listings, "r3", "ACME"),
            "6",
            "r3 still is"
        );
    }

    #[test]
    fn a_live_order_s_id_is_never_forgotten() {
        let (mut tracker, listings) = tracker(2);
        assert_eq!(outcome(&mut tracker, &listings, "live", "ACME"), "accepted");
        let accepted = Event::Accepted {
            order_id: OrderId(1),
            client_order_id: "live".to_string(),
            participant: participant("SIM", "MM-1"),
            symbol: "ACME".to_string(),
            side: Side::Sell,
            order_type: OrderType::Limit {
                price: PriceCents(4_210),
            },
            time_in_force: TimeInForce::Gtc,
            qty: Qty(10),
        };
        tracker.apply(&accepted, &listings);
        for i in 0..10 {
            outcome(&mut tracker, &listings, &format!("x{i}"), "NOPE");
        }
        assert_eq!(outcome(&mut tracker, &listings, "live", "ACME"), "6");
        // Ten retired, two remembered: memory follows the window, not the day.
        assert_eq!(tracker.client_ids["SIM"].ids.len(), 3);
        assert_eq!(tracker.client_ids["SIM"].retired.len(), 2);
    }

    #[test]
    fn a_snapshot_keeps_which_ids_go_first() {
        let (mut tracker, listings) = tracker(3);
        for id in ["a", "b", "c"] {
            outcome(&mut tracker, &listings, id, "NOPE");
        }
        let mut restored = OrderTracker::restore(&listings, tracker.state());
        assert_eq!(restored.state(), tracker.state());
        // One more: in both, "a" is the one forgotten.
        for t in [&mut tracker, &mut restored] {
            outcome(t, &listings, "d", "NOPE");
            assert_eq!(outcome(t, &listings, "b", "NOPE"), "6", "b remembered");
            assert_eq!(outcome(t, &listings, "a", "NOPE"), "1", "a forgotten");
        }
    }

    #[test]
    fn an_entry_packs_into_one_u64_and_back() {
        let big = OrderId((1 << 61) - 1);
        for entry in [
            ClientId::Spent,
            ClientId::Live(OrderId(1)),
            ClientId::Live(big),
            ClientId::Finished(OrderId(42), Ended::Filled),
            ClientId::Finished(OrderId(42), Ended::Canceled),
            ClientId::Finished(big, Ended::Expired),
        ] {
            assert_eq!(ClientId::unpack(entry.pack()), entry);
        }
        let key = client_key("SIM-1");
        assert_eq!(from_map_key(&map_key(key)), key);
        assert_eq!(
            std::mem::size_of::<(MapKey, u64)>(),
            24,
            "a map slot is 24 bytes"
        );
    }
}
