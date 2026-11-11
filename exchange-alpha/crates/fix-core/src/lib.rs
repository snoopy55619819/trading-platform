//! FIX 4.4 for Alpha Exchange: the wire codec, the data dictionary, and the session layer.
//!
//! - [`codec`] turns a TCP byte stream into messages and back, checking `BodyLength` and
//!   `CheckSum`.
//! - [`dictionary`] loads the published spec (`spec/fix44.xml`) and validates messages
//!   against it.
//! - [`session`] is the session state machine: logon, heartbeats, sequence numbers, gap
//!   detection and resend.
//! - [`decimal`] and [`time`] handle FIX's text formats for numbers and timestamps, exactly:
//!   no floats.
//!
//! This crate does no I/O and has never heard of an order book. The gateway owns the sockets
//! and the matching; this crate only speaks the protocol.

pub mod codec;
pub mod decimal;
pub mod dictionary;
pub mod message;
pub mod session;
pub mod tags;
pub mod time;

pub use codec::{Decoded, decode, encode};
pub use dictionary::{Dictionary, Violation};
pub use message::Message;
pub use session::{Action, Changes, Role, Session, SessionConfig, State};
pub use time::UtcMillis;
