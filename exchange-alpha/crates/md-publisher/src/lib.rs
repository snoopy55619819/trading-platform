//! Alpha Exchange's market data feed: the public, anonymous, sequenced view of the book.
//!
//! The gateway owns the engine. After every command it hands this crate the *public* part
//! of what happened ([`PublicEvent`]), and this crate does the rest:
//!
//! - [`public`] is the one place an engine event becomes public. Participants and order ids
//!   are dropped there, before anything is sequenced, stored or sent.
//! - [`feed`] numbers each message (`feed_seq` for the venue, `symbol_seq` per symbol),
//!   keeps every symbol's book as price levels, and remembers the last few messages. Pure:
//!   no sockets, no clock.
//! - [`hub`] fans messages out to subscribers and enforces the slow-subscriber policy.
//!   Also pure.
//! - [`server`] owns the WebSocket sockets and runs the hub on one task.
//! - [`mirror`] is the subscriber's side: rebuild a book from the feed and detect gaps.
//!   Used by `md-watch` and the tests, and the reference for what any consumer must do.
//!
//! The feed is rebuilt on restart the same way the book is: the gateway replays the journal
//! through it. Heartbeats and snapshots take no sequence number, so the numbers depend only
//! on the journal and carry on from where they were after a crash.

pub mod feed;
pub mod hub;
pub mod mirror;
pub mod public;
pub mod server;

/// Types generated from the published schema, `spec/marketdata.proto`.
pub mod proto {
    #![allow(clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/alpha.v1.rs"));
}

pub use feed::Feed;
pub use mirror::{Applied, Mirror};
pub use public::PublicEvent;
pub use server::{MarketData, Publisher};

/// Nanoseconds since the Unix epoch, the feed's timestamp unit.
pub fn now_ns() -> i64 {
    let since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(since_epoch.as_nanos()).unwrap_or(i64::MAX)
}
