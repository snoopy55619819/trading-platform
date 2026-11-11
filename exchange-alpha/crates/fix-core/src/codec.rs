//! Framing: bytes on a TCP stream to whole messages, and back.
//!
//! A FIX message on the wire is
//!
//! ```text
//! 8=FIX.4.4|9=<body length>|35=D|...body...|10=<checksum>|
//! ```
//!
//! with `|` standing for the SOH byte (0x01). `BodyLength` counts the bytes from just after
//! its own SOH up to and including the SOH before `10=`, which is how a reader knows where a
//! message ends in a stream that has no other delimiters. `CheckSum` is the sum of every
//! preceding byte, mod 256, as three digits.
//!
//! TCP delivers bytes, not messages: one read can hold half a message, or three and a bit.
//! [`decode`] therefore works on a growing buffer and takes whole messages off its front.

use crate::message::Message;
use crate::tags::{BODY_LENGTH, MSG_TYPE};

pub const SOH: u8 = 0x01;
pub const BEGIN_STRING: &str = "FIX.4.4";
const PREFIX: &[u8] = b"8=FIX.4.4\x019=";
/// Guards against a corrupt `BodyLength` making us wait forever for megabytes.
const MAX_BODY_LENGTH: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded {
    Message(Message),
    /// Bytes that cannot be a valid message. The FIX rule is to discard them silently
    /// without consuming a sequence number; the counterparty will notice the missing
    /// sequence number and resend.
    Garbled(String),
}

/// Takes the next complete message off the front of `buffer`.
///
/// Returns `None` when the buffer holds only part of a message: read more and call again.
pub fn decode(buffer: &mut Vec<u8>) -> Option<Decoded> {
    if buffer.is_empty() {
        return None;
    }
    if !buffer.starts_with(PREFIX) {
        if PREFIX.starts_with(buffer) {
            return None; // the start of a message, cut off mid-prefix
        }
        return Some(discard_to_next_message(
            buffer,
            "expected 8=FIX.4.4 then 9=",
        ));
    }

    // 9=<digits><SOH>
    let digits_start = PREFIX.len();
    let Some(digits_len) = buffer[digits_start..].iter().position(|&b| b == SOH) else {
        return (buffer.len() - digits_start > 6)
            .then(|| discard_to_next_message(buffer, "unterminated BodyLength"));
    };
    let digits = &buffer[digits_start..digits_start + digits_len];
    let parsed = std::str::from_utf8(digits)
        .ok()
        .and_then(|s| s.parse::<usize>().ok());
    let body_length = match parsed {
        Some(length) if length <= MAX_BODY_LENGTH && !digits.is_empty() => length,
        _ => {
            return Some(discard_to_next_message(
                buffer,
                "BodyLength is not a number",
            ));
        }
    };

    let body_start = digits_start + digits_len + 1;
    let body_end = body_start + body_length;
    let frame_end = body_end + 7; // "10=" + three digits + SOH
    if buffer.len() < frame_end {
        return None;
    }

    let trailer_ok = body_length > 0
        && buffer[body_end - 1] == SOH
        && &buffer[body_end..body_end + 3] == b"10="
        && buffer[frame_end - 1] == SOH;
    if !trailer_ok {
        return Some(discard_to_next_message(
            buffer,
            "BodyLength does not land on the CheckSum field",
        ));
    }

    let declared = std::str::from_utf8(&buffer[body_end + 3..body_end + 6])
        .ok()
        .and_then(|s| s.parse::<u32>().ok());
    let actual = checksum(&buffer[..body_end]);
    if declared != Some(actual) {
        buffer.drain(..frame_end);
        return Some(Decoded::Garbled(format!(
            "CheckSum mismatch: computed {actual:03}"
        )));
    }

    let body: Vec<u8> = buffer[body_start..body_end - 1].to_vec(); // without the final SOH
    buffer.drain(..frame_end);
    Some(match parse_fields(&body) {
        Ok(fields) => Decoded::Message(Message::from_fields(fields)),
        Err(why) => Decoded::Garbled(why),
    })
}

/// Encodes a message, adding `BeginString`, `BodyLength` and `CheckSum`.
pub fn encode(message: &Message) -> Vec<u8> {
    let mut body = Vec::with_capacity(256);
    for (tag, value) in message.fields() {
        body.extend_from_slice(tag.to_string().as_bytes());
        body.push(b'=');
        body.extend_from_slice(value.as_bytes());
        body.push(SOH);
    }

    let mut out = Vec::with_capacity(body.len() + 32);
    out.extend_from_slice(PREFIX);
    out.extend_from_slice(body.len().to_string().as_bytes());
    out.push(SOH);
    out.extend_from_slice(&body);
    let sum = checksum(&out);
    out.extend_from_slice(format!("10={sum:03}").as_bytes());
    out.push(SOH);
    out
}

/// Sum of all bytes, mod 256.
pub fn checksum(bytes: &[u8]) -> u32 {
    bytes.iter().map(|&b| b as u32).sum::<u32>() % 256
}

fn parse_fields(body: &[u8]) -> Result<Vec<(u32, String)>, String> {
    let text = std::str::from_utf8(body).map_err(|_| "body is not valid text".to_string())?;
    let mut fields = Vec::new();
    for pair in text.split('\x01') {
        let (tag, value) = pair
            .split_once('=')
            .ok_or_else(|| format!("field {pair:?} has no ="))?;
        let tag: u32 = tag
            .parse()
            .map_err(|_| format!("tag {tag:?} is not a number"))?;
        if tag == BODY_LENGTH {
            return Err("BodyLength appears twice".into());
        }
        fields.push((tag, value.to_string()));
    }
    match fields.first() {
        Some((MSG_TYPE, _)) => Ok(fields),
        _ => Err("MsgType must be the first field after BodyLength".into()),
    }
}

/// Drops bytes up to the next plausible message start, so one corrupt message does not
/// poison everything after it.
fn discard_to_next_message(buffer: &mut Vec<u8>, why: &str) -> Decoded {
    let next = buffer[1..]
        .windows(2)
        .position(|w| w == b"8=")
        .map_or(buffer.len(), |i| i + 1);
    buffer.drain(..next);
    Decoded::Garbled(why.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(text: &str) -> Vec<u8> {
        text.replace('|', "\x01").into_bytes()
    }

    #[test]
    fn matches_a_hand_built_message() {
        // BodyLength and CheckSum computed independently for this exact message.
        let raw = wire("8=FIX.4.4|9=5|35=0|10=163|");
        let mut buffer = raw.clone();
        assert_eq!(
            decode(&mut buffer),
            Some(Decoded::Message(Message::new("0")))
        );
        assert!(buffer.is_empty());
        assert_eq!(encode(&Message::new("0")), raw);
    }

    #[test]
    fn round_trips() {
        let message = Message::new("D")
            .with(49, "BROKER")
            .with(56, "ALPHA")
            .with(34, "2")
            .with(11, "ord-1")
            .with(44, "42.10");
        let mut buffer = encode(&message);
        assert_eq!(decode(&mut buffer), Some(Decoded::Message(message)));
    }

    #[test]
    fn waits_for_the_rest_of_a_split_message() {
        let raw = encode(&Message::new("1").with(112, "ping"));
        for split in 1..raw.len() {
            let mut buffer = raw[..split].to_vec();
            assert_eq!(decode(&mut buffer), None, "split at {split}");
            buffer.extend_from_slice(&raw[split..]);
            assert!(matches!(decode(&mut buffer), Some(Decoded::Message(_))));
        }
    }

    #[test]
    fn takes_several_messages_off_one_buffer_in_order() {
        let mut buffer = Vec::new();
        for id in ["a", "b", "c"] {
            buffer.extend(encode(&Message::new("1").with(112, id)));
        }
        buffer.extend_from_slice(&encode(&Message::new("0"))[..10]); // and a partial one
        let ids: Vec<String> = std::iter::from_fn(|| decode(&mut buffer))
            .map(|decoded| match decoded {
                Decoded::Message(m) => m.get(112).unwrap().to_string(),
                Decoded::Garbled(why) => panic!("{why}"),
            })
            .collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(
            buffer.len(),
            10,
            "the partial message is left for the next read"
        );
    }

    #[test]
    fn rejects_a_bad_checksum_without_trying_to_repair_it() {
        let mut buffer = wire("8=FIX.4.4|9=5|35=0|10=164|");
        assert!(matches!(decode(&mut buffer), Some(Decoded::Garbled(_))));
        assert!(buffer.is_empty());
    }

    #[test]
    fn rejects_a_wrong_body_length_and_recovers_at_the_next_message() {
        let mut buffer = wire("8=FIX.4.4|9=4|35=0|10=163|");
        buffer.extend(encode(&Message::new("1").with(112, "next")));
        assert!(matches!(decode(&mut buffer), Some(Decoded::Garbled(_))));
        match decode(&mut buffer) {
            Some(Decoded::Message(m)) => assert_eq!(m.get(112), Some("next")),
            other => panic!("expected the next message, got {other:?}"),
        }
    }

    #[test]
    fn skips_leading_junk() {
        let mut buffer = b"noise".to_vec();
        buffer.extend(encode(&Message::new("0")));
        assert!(matches!(decode(&mut buffer), Some(Decoded::Garbled(_))));
        assert!(matches!(decode(&mut buffer), Some(Decoded::Message(_))));
    }
}
