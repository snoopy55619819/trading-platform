//! A FIX message as an ordered list of `tag=value` fields.
//!
//! A `Message` holds `MsgType(35)` first, then every other field in order. The framing fields
//! `BeginString(8)`, `BodyLength(9)` and `CheckSum(10)` are not stored: the codec adds them
//! on the way out and checks and strips them on the way in.

use crate::decimal::{self, DecimalError};
use crate::tags::MSG_TYPE;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    fields: Vec<(u32, String)>,
}

impl Message {
    pub fn new(msg_type: &str) -> Self {
        Message {
            fields: vec![(MSG_TYPE, msg_type.to_string())],
        }
    }

    /// Builds a message from decoded fields. The codec guarantees `MsgType` comes first.
    pub(crate) fn from_fields(fields: Vec<(u32, String)>) -> Self {
        debug_assert_eq!(fields.first().map(|(tag, _)| *tag), Some(MSG_TYPE));
        Message { fields }
    }

    pub fn msg_type(&self) -> &str {
        &self.fields[0].1
    }

    pub fn get(&self, tag: u32) -> Option<&str> {
        self.fields
            .iter()
            .find(|(t, _)| *t == tag)
            .map(|(_, value)| value.as_str())
    }

    pub fn has(&self, tag: u32) -> bool {
        self.get(tag).is_some()
    }

    /// Sets a field, replacing it if present, appending it otherwise.
    pub fn set(&mut self, tag: u32, value: impl Into<String>) {
        let value = value.into();
        debug_assert!(!value.contains('\x01'), "SOH inside tag {tag}'s value");
        match self.fields.iter_mut().find(|(t, _)| *t == tag) {
            Some(field) => field.1 = value,
            None => self.fields.push((tag, value)),
        }
    }

    /// Builder form of [`set`](Self::set).
    pub fn with(mut self, tag: u32, value: impl Into<String>) -> Self {
        self.set(tag, value);
        self
    }

    pub fn remove(&mut self, tag: u32) {
        self.fields.retain(|(t, _)| *t != tag);
    }

    pub fn fields(&self) -> &[(u32, String)] {
        &self.fields
    }

    pub fn get_u64(&self, tag: u32) -> Option<u64> {
        self.get(tag)?.parse().ok()
    }

    /// `BOOLEAN` fields: `Y` is true, anything else (including absent) is false.
    pub fn get_bool(&self, tag: u32) -> bool {
        self.get(tag) == Some("Y")
    }

    /// A decimal field as an exact integer of `10^-scale` units (prices use scale 2: cents).
    pub fn get_scaled(&self, tag: u32, scale: u32) -> Option<Result<i64, DecimalError>> {
        self.get(tag).map(|text| decimal::parse_scaled(text, scale))
    }

    /// Moves header fields into the order FIX expects after `MsgType`, so encoded output
    /// reads naturally: sender, target, sequence number, timing, then the body.
    pub(crate) fn order_header_first(&mut self, header_tags: &[u32]) {
        let rank = |tag: u32| {
            header_tags
                .iter()
                .position(|&t| t == tag)
                .unwrap_or(usize::MAX)
        };
        // Stable sort: the body keeps its own order behind the header.
        self.fields[1..].sort_by_key(|(tag, _)| rank(*tag));
    }
}
