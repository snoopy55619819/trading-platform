//! Sequenced market data feed.
//!
//! Snapshot plus incremental deltas, every message stamped with a monotonic `feed_seq`
//! that never resets or skips. Sees only the engine's public output - never an account
//! id or a client order id.
//!
//! Milestone 3.
