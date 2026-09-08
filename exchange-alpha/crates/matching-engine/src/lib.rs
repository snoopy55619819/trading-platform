//! The limit order book and matching.
//!
//! Price-time priority: best price first, strict FIFO within a level. State lives in RAM;
//! durability is an append-only journal; recovery is replay, and replay must reproduce a
//! byte-identical book.
//!
//! Knows nothing about networks, FIX, or databases. Milestone 1.
