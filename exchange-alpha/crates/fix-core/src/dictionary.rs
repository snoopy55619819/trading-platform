//! The data dictionary: which messages and fields exist, which are required, and what values
//! each may take.
//!
//! Loaded from the exchange's published spec, `spec/fix44.xml`, embedded at compile time so
//! the binary can never disagree with the spec it was built from. It is QuickFIX's XML format,
//! which is what lets a QuickFIX client load the very same file and check us independently.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use crate::decimal;
use crate::message::Message;
use crate::tags::{BEGIN_STRING, BODY_LENGTH, CHECK_SUM, session_reject_reason as reason};
use crate::time::UtcMillis;

const SPEC: &str = include_str!("../../../spec/fix44.xml");

static FIX44: LazyLock<Dictionary> = LazyLock::new(|| {
    Dictionary::parse(SPEC).unwrap_or_else(|error| panic!("spec/fix44.xml is invalid: {error}"))
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldType {
    String,
    Char,
    Int,
    Length,
    SeqNum,
    Qty,
    Price,
    Amt,
    Boolean,
    UtcTimestamp,
    Currency,
}

#[derive(Debug)]
pub struct FieldDef {
    pub name: String,
    pub kind: FieldType,
    /// Allowed values, if the field is an enumeration. Empty means any well-formed value.
    pub values: HashSet<String>,
}

#[derive(Debug, Clone, Copy)]
struct FieldRef {
    tag: u32,
    required: bool,
}

#[derive(Debug)]
pub struct MessageDef {
    pub name: String,
    pub admin: bool,
    fields: Vec<FieldRef>,
}

/// Why a message failed validation, in the terms a session-level `Reject(3)` needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    /// A `SessionRejectReason(373)` value.
    pub reason: u32,
    pub tag: Option<u32>,
    pub text: String,
}

#[derive(Debug)]
pub struct Dictionary {
    fields: HashMap<u32, FieldDef>,
    header: Vec<FieldRef>,
    trailer: Vec<FieldRef>,
    messages: HashMap<String, MessageDef>,
}

impl Dictionary {
    /// The published Alpha Exchange FIX 4.4 dictionary.
    pub fn fix44() -> &'static Dictionary {
        &FIX44
    }

    pub fn message(&self, msg_type: &str) -> Option<&MessageDef> {
        self.messages.get(msg_type)
    }

    pub fn field(&self, tag: u32) -> Option<&FieldDef> {
        self.fields.get(&tag)
    }

    /// Checks a message against the dictionary. The first problem found is returned, which is
    /// all a `Reject` can carry anyway.
    pub fn validate(&self, message: &Message) -> Result<(), Violation> {
        let msg_type = message.msg_type();
        let Some(definition) = self.messages.get(msg_type) else {
            return Err(violation(
                reason::INVALID_MSG_TYPE,
                Some(crate::tags::MSG_TYPE),
                format!("unsupported MsgType {msg_type:?}"),
            ));
        };

        let allowed = |tag: u32| {
            self.header
                .iter()
                .chain(&self.trailer)
                .chain(&definition.fields)
                .any(|f| f.tag == tag)
        };

        let mut seen = HashSet::new();
        for (tag, value) in message.fields() {
            let Some(field) = self.fields.get(tag) else {
                return Err(violation(
                    reason::INVALID_TAG_NUMBER,
                    Some(*tag),
                    format!("unknown tag {tag}"),
                ));
            };
            if !allowed(*tag) {
                return Err(violation(
                    reason::TAG_NOT_DEFINED_FOR_MESSAGE_TYPE,
                    Some(*tag),
                    format!("{} is not allowed in {}", field.name, definition.name),
                ));
            }
            if !seen.insert(*tag) {
                return Err(violation(
                    reason::VALUE_IS_INCORRECT,
                    Some(*tag),
                    format!("{} appears more than once", field.name),
                ));
            }
            if value.is_empty() {
                return Err(violation(
                    reason::VALUE_IS_INCORRECT,
                    Some(*tag),
                    format!("{} has no value", field.name),
                ));
            }
            if !well_formed(field.kind, value) {
                return Err(violation(
                    reason::INCORRECT_DATA_FORMAT,
                    Some(*tag),
                    format!("{} {value:?} is not a valid {:?}", field.name, field.kind),
                ));
            }
            if !field.values.is_empty() && !field.values.contains(value) {
                return Err(violation(
                    reason::VALUE_IS_INCORRECT,
                    Some(*tag),
                    format!("{value:?} is not a valid {}", field.name),
                ));
            }
        }

        let framing = [BEGIN_STRING, BODY_LENGTH, CHECK_SUM]; // checked by the codec
        for required in self
            .header
            .iter()
            .chain(&self.trailer)
            .chain(&definition.fields)
            .filter(|f| f.required && !framing.contains(&f.tag))
        {
            if !message.has(required.tag) {
                let name = &self.fields[&required.tag].name;
                return Err(violation(
                    reason::REQUIRED_TAG_MISSING,
                    Some(required.tag),
                    format!("{} requires {name}", definition.name),
                ));
            }
        }
        Ok(())
    }

    /// Parses a QuickFIX-format data dictionary.
    pub fn parse(xml: &str) -> Result<Dictionary, String> {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().trim_text(true);

        // Field references come before the field definitions in the file, so references are
        // collected by name and resolved to tag numbers at the end.
        struct NamedRef {
            name: String,
            required: bool,
        }
        struct RawMessage {
            msg_type: String,
            name: String,
            admin: bool,
            fields: Vec<NamedRef>,
        }
        let mut header: Vec<NamedRef> = Vec::new();
        let mut trailer: Vec<NamedRef> = Vec::new();
        let mut messages: Vec<RawMessage> = Vec::new();
        let mut fields: HashMap<u32, FieldDef> = HashMap::new();

        #[derive(PartialEq)]
        enum Section {
            None,
            Header,
            Trailer,
            Message,
            Fields,
        }
        let mut section = Section::None;
        let mut current_field: Option<u32> = None;

        loop {
            let event = reader.read_event().map_err(|e| e.to_string())?;
            let (element, has_children) = match &event {
                Event::Start(e) => (e.clone(), true),
                Event::Empty(e) => (e.clone(), false),
                Event::End(e) => {
                    match e.name().as_ref() {
                        b"header" | b"trailer" | b"message" | b"fields" => section = Section::None,
                        b"field" if section == Section::Fields => current_field = None,
                        _ => {}
                    }
                    continue;
                }
                Event::Eof => break,
                _ => continue,
            };

            match (element.name().as_ref(), &section) {
                (b"header", _) => section = Section::Header,
                (b"trailer", _) => section = Section::Trailer,
                (b"fields", _) => section = Section::Fields,
                (b"message", _) => {
                    messages.push(RawMessage {
                        msg_type: required_attr(&element, "msgtype")?,
                        name: required_attr(&element, "name")?,
                        admin: attr(&element, "msgcat")?.as_deref() == Some("admin"),
                        fields: Vec::new(),
                    });
                    section = Section::Message;
                }
                (b"field", Section::Header | Section::Trailer | Section::Message) => {
                    let reference = NamedRef {
                        name: required_attr(&element, "name")?,
                        required: attr(&element, "required")?.as_deref() == Some("Y"),
                    };
                    match section {
                        Section::Header => header.push(reference),
                        Section::Trailer => trailer.push(reference),
                        _ => messages
                            .last_mut()
                            .expect("inside a message")
                            .fields
                            .push(reference),
                    }
                }
                (b"field", Section::Fields) => {
                    let number = required_attr(&element, "number")?;
                    let tag: u32 = number
                        .parse()
                        .map_err(|_| format!("field number {number:?}"))?;
                    let kind = field_type(&required_attr(&element, "type")?)?;
                    fields.insert(
                        tag,
                        FieldDef {
                            name: required_attr(&element, "name")?,
                            kind,
                            values: HashSet::new(),
                        },
                    );
                    current_field = has_children.then_some(tag);
                }
                (b"value", Section::Fields) => {
                    if let Some(tag) = current_field {
                        let value = required_attr(&element, "enum")?;
                        fields
                            .get_mut(&tag)
                            .expect("defined above")
                            .values
                            .insert(value);
                    }
                }
                _ => {}
            }
        }

        let by_name: HashMap<&str, u32> = fields
            .iter()
            .map(|(tag, def)| (def.name.as_str(), *tag))
            .collect();
        let resolve = |refs: &[NamedRef]| -> Result<Vec<FieldRef>, String> {
            refs.iter()
                .map(|reference| {
                    by_name
                        .get(reference.name.as_str())
                        .map(|&tag| FieldRef {
                            tag,
                            required: reference.required,
                        })
                        .ok_or_else(|| {
                            format!("field {} is used but never defined", reference.name)
                        })
                })
                .collect()
        };

        let mut message_defs = HashMap::new();
        for message in &messages {
            message_defs.insert(
                message.msg_type.clone(),
                MessageDef {
                    name: message.name.clone(),
                    admin: message.admin,
                    fields: resolve(&message.fields)?,
                },
            );
        }
        Ok(Dictionary {
            header: resolve(&header)?,
            trailer: resolve(&trailer)?,
            messages: message_defs,
            fields,
        })
    }
}

fn violation(reason: u32, tag: Option<u32>, text: String) -> Violation {
    Violation { reason, tag, text }
}

fn well_formed(kind: FieldType, value: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match kind {
        FieldType::String => true,
        FieldType::Char => value.chars().count() == 1,
        FieldType::Int => digits(value.strip_prefix('-').unwrap_or(value)),
        FieldType::Length | FieldType::SeqNum => digits(value),
        // Scale 9 accepts any sensible precision; the gateway re-parses at the scale it needs.
        FieldType::Qty | FieldType::Price | FieldType::Amt => {
            decimal::parse_scaled(value, 9).is_ok()
        }
        FieldType::Boolean => value == "Y" || value == "N",
        FieldType::UtcTimestamp => UtcMillis::parse_fix(value).is_some(),
        FieldType::Currency => value.len() == 3 && value.bytes().all(|b| b.is_ascii_uppercase()),
    }
}

fn field_type(name: &str) -> Result<FieldType, String> {
    Ok(match name {
        "STRING" => FieldType::String,
        "CHAR" => FieldType::Char,
        "INT" => FieldType::Int,
        "LENGTH" => FieldType::Length,
        "SEQNUM" => FieldType::SeqNum,
        "QTY" => FieldType::Qty,
        "PRICE" => FieldType::Price,
        "AMT" => FieldType::Amt,
        "BOOLEAN" => FieldType::Boolean,
        "UTCTIMESTAMP" => FieldType::UtcTimestamp,
        "CURRENCY" => FieldType::Currency,
        other => return Err(format!("unsupported field type {other}")),
    })
}

fn attr(element: &BytesStart, name: &str) -> Result<Option<String>, String> {
    match element.try_get_attribute(name).map_err(|e| e.to_string())? {
        Some(attribute) => Ok(Some(
            attribute
                .unescape_value()
                .map_err(|e| e.to_string())?
                .into_owned(),
        )),
        None => Ok(None),
    }
}

fn required_attr(element: &BytesStart, name: &str) -> Result<String, String> {
    attr(element, name)?.ok_or_else(|| {
        format!(
            "<{}> is missing {name}",
            String::from_utf8_lossy(element.name().as_ref())
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tags::*;

    fn new_order() -> Message {
        Message::new("D")
            .with(SENDER_COMP_ID, "BROKER")
            .with(TARGET_COMP_ID, "ALPHA")
            .with(MSG_SEQ_NUM, "2")
            .with(SENDING_TIME, "20260907-14:32:11.123")
            .with(CL_ORD_ID, "ord-1")
            .with(ACCOUNT, "acct-1")
            .with(SYMBOL, "ACME")
            .with(SIDE, "1")
            .with(TRANSACT_TIME, "20260907-14:32:11.123")
            .with(ORDER_QTY, "100")
            .with(ORD_TYPE, "2")
            .with(PRICE, "42.10")
    }

    fn reason_of(message: &Message) -> Option<(u32, Option<u32>)> {
        Dictionary::fix44()
            .validate(message)
            .err()
            .map(|v| (v.reason, v.tag))
    }

    #[test]
    fn the_published_spec_loads() {
        let dictionary = Dictionary::fix44();
        assert_eq!(dictionary.messages.len(), 11);
        assert_eq!(dictionary.fields.len(), 51);
        assert!(dictionary.message("A").unwrap().admin);
        assert!(!dictionary.message("D").unwrap().admin);
    }

    #[test]
    fn a_complete_new_order_is_valid() {
        assert_eq!(reason_of(&new_order()), None);
    }

    #[test]
    fn missing_required_fields_are_named() {
        let mut message = new_order();
        message.remove(SYMBOL);
        assert_eq!(
            reason_of(&message),
            Some((reason::REQUIRED_TAG_MISSING, Some(SYMBOL)))
        );
        let mut message = new_order();
        message.remove(SENDING_TIME);
        assert_eq!(
            reason_of(&message),
            Some((reason::REQUIRED_TAG_MISSING, Some(SENDING_TIME)))
        );
    }

    #[test]
    fn unknown_and_misplaced_tags_are_rejected() {
        assert_eq!(
            reason_of(&new_order().with(9999, "x")),
            Some((reason::INVALID_TAG_NUMBER, Some(9999)))
        );
        // TestReqID is a real field, but not part of a NewOrderSingle
        assert_eq!(
            reason_of(&new_order().with(TEST_REQ_ID, "x")),
            Some((reason::TAG_NOT_DEFINED_FOR_MESSAGE_TYPE, Some(TEST_REQ_ID)))
        );
    }

    #[test]
    fn values_must_be_well_formed_and_in_the_enumeration() {
        assert_eq!(
            reason_of(&new_order().with(SIDE, "7")),
            Some((reason::VALUE_IS_INCORRECT, Some(SIDE)))
        );
        assert_eq!(
            reason_of(&new_order().with(PRICE, "forty-two")),
            Some((reason::INCORRECT_DATA_FORMAT, Some(PRICE)))
        );
        assert_eq!(
            reason_of(&new_order().with(TRANSACT_TIME, "yesterday")),
            Some((reason::INCORRECT_DATA_FORMAT, Some(TRANSACT_TIME)))
        );
    }

    #[test]
    fn unsupported_message_types_are_rejected() {
        assert_eq!(
            reason_of(&Message::new("Z")),
            Some((reason::INVALID_MSG_TYPE, Some(MSG_TYPE)))
        );
    }
}
