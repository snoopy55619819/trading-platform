//! The limit order book and matching engine for Alpha Exchange.
//!
//! **Price-time priority.** The best price trades first; among orders at the same price, the
//! one that arrived first trades first. An incoming order that crosses the spread "walks the
//! book", taking the best level, then the next, producing one trade per resting order it
//! meets. The trade price is always the resting order's price.
//!
//! **State lives in RAM. Durability is an append-only journal. Recovery is replay.** The
//! engine is deterministic, so replaying the journal into a fresh engine rebuilds an
//! identical one, ids included. There is no database here, by design.
//!
//! **This crate knows nothing about networks, FIX, protobuf or SQL.** The gateway turns FIX
//! into [`Command`]s and [`Event`]s back into execution reports; md-publisher turns the
//! public events into the market data feed.
//!
//! ```
//! use matching_engine::*;
//!
//! let order = |who: &str, side, cents| {
//!     Command::New(NewOrder {
//!         client_order_id: format!("{who}-1"),
//!         participant: who.to_string(),
//!         symbol: "ACME".to_string(),
//!         side,
//!         order_type: OrderType::Limit { price: PriceCents(cents) },
//!         time_in_force: TimeInForce::Gtc,
//!         qty: Qty(100),
//!     })
//! };
//!
//! let mut engine = Engine::default();
//! engine.apply(order("alice", Side::Sell, 4210));
//! let events = engine.apply(order("bob", Side::Buy, 4215));
//!
//! // Bob was willing to pay 42.15, but trades at Alice's resting price of 42.10.
//! let trade = events.iter().find_map(|e| match e {
//!     Event::Trade(t) => Some(t),
//!     _ => None,
//! });
//! assert_eq!(trade.unwrap().price, PriceCents(4210));
//! ```

mod book;
mod command;
mod engine;
mod event;
mod journal;
mod types;

pub use book::{LevelView, OrderBook, RestingOrder};
pub use command::{CancelOrder, Command, NewOrder};
pub use engine::{BookSnapshot, Engine, LevelSnapshot, Snapshot};
pub use event::{BookDelta, CancelReason, Event, RejectReason, Trade};
pub use journal::{Journal, JournaledEngine};
pub use types::{OrderId, OrderType, ParsePriceError, PriceCents, Qty, Side, TimeInForce, TradeId};
