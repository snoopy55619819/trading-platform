//! Alpha Exchange's gateway: the FIX 4.4 acceptor in front of the matching engine.
//!
//! The only crate that has heard of both FIX and order books, which is exactly why the
//! others have not.
//!
//! - [`server`] owns the sockets and nothing else.
//! - [`core`] is the single task that owns the engine and every FIX session.
//! - [`orders`] validates orders and translates between FIX and engine commands and events.
//! - [`store`] persists FIX session state in the exchange's own database.
//! - [`listings`] is the published instrument list and fee schedule.
//!
//! Market data lives in its own crate, `md-publisher`; the core only hands it public events.

pub mod core;
pub mod listings;
pub mod orders;
pub mod server;
pub mod store;

pub use crate::core::Core;
pub use server::Gateway;
pub use store::{MemoryStore, PgStore, SessionStore};
