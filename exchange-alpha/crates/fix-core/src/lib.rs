//! FIX 4.4 codec and session state machine.
//!
//! Owns framing (BeginString/BodyLength/CheckSum), the session layer (Logon, Heartbeat,
//! TestRequest, ResendRequest, SequenceReset, Logout, sequence numbers, gap fill) and
//! encode/decode against `spec/fix44.xml`.
//!
//! Knows nothing about order books. Milestone 2.
