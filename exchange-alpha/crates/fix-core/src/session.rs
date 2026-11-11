//! The FIX session layer: logon, heartbeats, sequence numbers, gap detection and resend.
//!
//! A `Session` is a pure state machine. It never touches a socket or reads the clock: the
//! caller feeds it messages and the current time, and it answers with [`Action`]s (send these
//! bytes, deliver this message to the application, disconnect). That is what lets every
//! sequence-gap and timeout rule be tested in microseconds, and lets the same code serve both
//! an acceptor (the exchange) and an initiator (a client).
//!
//! The rule everything here protects: **no message is lost and none is processed twice.**
//! Every message carries a sequence number, each side tracks the next number it expects, and
//! a gap means messages went missing, so the receiver asks for them again (`ResendRequest`).
//! Sequence numbers belong to the session, not the TCP connection: they survive disconnects,
//! and the caller persists them so they survive restarts too.

use std::collections::BTreeMap;

use crate::codec::{self, Decoded};
use crate::dictionary::Dictionary;
use crate::message::Message;
use crate::tags::{msg_type, session_reject_reason as reason, *};
use crate::time::UtcMillis;

/// How long to wait for the counterparty to confirm a logout before dropping the connection.
const LOGOUT_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Waits for the counterparty's Logon. The exchange.
    Acceptor,
    /// Sends the Logon. A client.
    Initiator,
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Our CompID: the `SenderCompID` on everything we send.
    pub our_comp_id: String,
    /// The counterparty's CompID.
    pub their_comp_id: String,
    pub role: Role,
    /// The heartbeat interval an initiator proposes. An acceptor adopts whatever the
    /// counterparty's Logon asks for.
    pub heartbeat_secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Disconnected,
    /// Connected, no Logon received yet (acceptor).
    AwaitingLogon,
    /// Logon sent, no reply yet (initiator).
    LogonSent,
    Active,
    LogoutSent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Write these bytes to the connection.
    Send(Vec<u8>),
    /// An application message for the caller to act on.
    Deliver(Message),
    /// Close the connection.
    Disconnect(String),
}

/// What changed since the caller last persisted this session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Changes {
    pub next_in_seq: u64,
    pub next_out_seq: u64,
    /// Sequence numbers were reset: forget every previously stored outbound message.
    pub reset: bool,
    /// Outbound messages to store for possible resend, by sequence number.
    pub new_outbound: Vec<(u64, Vec<u8>)>,
}

pub struct Session {
    config: SessionConfig,
    state: State,
    /// The sequence number we expect on the next inbound message.
    next_in: u64,
    /// The sequence number our next outbound message will carry.
    next_out: u64,
    heartbeat_ms: u64,
    last_received: UtcMillis,
    last_sent: UtcMillis,
    /// A TestRequest we sent and are waiting on: its id and when we sent it.
    test_request: Option<(String, UtcMillis)>,
    test_request_count: u64,
    /// While waiting for a resend we asked for: the highest sequence number seen, so we know
    /// when we have caught up and stop treating later messages as part of the gap.
    resend_until: Option<u64>,
    logout_sent_at: Option<UtcMillis>,
    /// Every message we have sent, for resend. Kept for the life of the session.
    outbound: BTreeMap<u64, Vec<u8>>,
    unsaved: Vec<u64>,
    reset: bool,
    dirty: bool,
}

impl Session {
    pub fn new(config: SessionConfig) -> Session {
        Session::restore(config, 1, 1, Vec::new())
    }

    /// Recreates a session from persisted state, so a restart resumes the sequence numbers
    /// instead of starting again at 1.
    pub fn restore(
        config: SessionConfig,
        next_in_seq: u64,
        next_out_seq: u64,
        outbound: impl IntoIterator<Item = (u64, Vec<u8>)>,
    ) -> Session {
        let heartbeat_ms = config.heartbeat_secs * 1000;
        Session {
            config,
            state: State::Disconnected,
            next_in: next_in_seq,
            next_out: next_out_seq,
            heartbeat_ms,
            last_received: UtcMillis(0),
            last_sent: UtcMillis(0),
            test_request: None,
            test_request_count: 0,
            resend_until: None,
            logout_sent_at: None,
            outbound: outbound.into_iter().collect(),
            unsaved: Vec::new(),
            reset: false,
            dirty: false,
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn is_active(&self) -> bool {
        self.state == State::Active
    }

    pub fn next_in_seq(&self) -> u64 {
        self.next_in
    }

    pub fn next_out_seq(&self) -> u64 {
        self.next_out
    }

    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    /// A connection was established. An initiator logs on; an acceptor waits to be asked.
    pub fn on_connected(&mut self, now: UtcMillis) -> Vec<Action> {
        self.last_received = now;
        self.test_request = None;
        self.resend_until = None;
        self.logout_sent_at = None;
        let mut actions = Vec::new();
        match self.config.role {
            Role::Acceptor => self.state = State::AwaitingLogon,
            Role::Initiator => {
                self.state = State::LogonSent;
                let logon = Message::new(msg_type::LOGON)
                    .with(ENCRYPT_METHOD, "0")
                    .with(HEART_BT_INT, self.config.heartbeat_secs.to_string());
                self.send_admin(logon, now, &mut actions);
            }
        }
        actions
    }

    /// The connection is gone. Sequence numbers are kept: they belong to the session.
    pub fn on_disconnected(&mut self) {
        self.state = State::Disconnected;
        self.test_request = None;
        self.resend_until = None;
        self.logout_sent_at = None;
    }

    /// Sends an application message. It is stored and numbered whether or not we are
    /// connected; if we are not, the counterparty recovers it by resend after logging on.
    pub fn send(&mut self, message: Message, now: UtcMillis) -> Vec<Action> {
        let mut actions = Vec::new();
        let connected = self.state == State::Active;
        self.stamp_and_store(message, now, connected, &mut actions);
        actions
    }

    /// Starts a graceful logout.
    pub fn logout(&mut self, text: &str, now: UtcMillis) -> Vec<Action> {
        let mut actions = Vec::new();
        self.send_admin(
            Message::new(msg_type::LOGOUT).with(TEXT, text),
            now,
            &mut actions,
        );
        self.state = State::LogoutSent;
        self.logout_sent_at = Some(now);
        actions
    }

    /// Timers: heartbeats when we have been quiet, TestRequest when they have, and giving up
    /// on a counterparty that stopped answering.
    pub fn tick(&mut self, now: UtcMillis) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Some(sent_at) = self.logout_sent_at {
            if now.since(sent_at) >= LOGOUT_TIMEOUT_MS {
                actions.push(Action::Disconnect("no reply to Logout".into()));
            }
            return actions;
        }
        if self.state != State::Active || self.heartbeat_ms == 0 {
            return actions;
        }

        if now.since(self.last_sent) >= self.heartbeat_ms {
            self.send_admin(Message::new(msg_type::HEARTBEAT), now, &mut actions);
        }
        match &self.test_request {
            Some((_, sent_at)) if now.since(*sent_at) >= self.heartbeat_ms => {
                actions.push(Action::Disconnect(
                    "no reply to TestRequest; counterparty presumed dead".into(),
                ));
            }
            Some(_) => {}
            // Quiet for a heartbeat interval plus 20%: they should have sent something.
            None if now.since(self.last_received) >= self.heartbeat_ms * 6 / 5 => {
                self.test_request_count += 1;
                let id = format!("TEST-{}", self.test_request_count);
                let request = Message::new(msg_type::TEST_REQUEST).with(TEST_REQ_ID, id.clone());
                self.send_admin(request, now, &mut actions);
                self.test_request = Some((id, now));
            }
            None => {}
        }
        actions
    }

    /// Persistence: everything that changed since the last call, or `None` if nothing did.
    pub fn take_changes(&mut self) -> Option<Changes> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        let new_outbound = self
            .unsaved
            .drain(..)
            .filter_map(|seq| self.outbound.get(&seq).map(|raw| (seq, raw.clone())))
            .collect();
        Some(Changes {
            next_in_seq: self.next_in,
            next_out_seq: self.next_out,
            reset: std::mem::take(&mut self.reset),
            new_outbound,
        })
    }

    /// Handles one inbound message.
    pub fn receive(&mut self, message: Message, now: UtcMillis) -> Vec<Action> {
        let mut actions = Vec::new();
        self.last_received = now;
        // Any traffic proves the counterparty is alive, which is all a TestRequest asks.
        self.test_request = None;
        let kind = message.msg_type().to_string();

        if message.get(SENDER_COMP_ID) != Some(self.config.their_comp_id.as_str())
            || message.get(TARGET_COMP_ID) != Some(self.config.our_comp_id.as_str())
        {
            self.fail(
                "SenderCompID/TargetCompID do not match this session",
                now,
                &mut actions,
            );
            return actions;
        }
        let Some(seq) = message.get_u64(MSG_SEQ_NUM) else {
            self.fail("MsgSeqNum missing or not a number", now, &mut actions);
            return actions;
        };

        let awaiting_logon = matches!(self.state, State::AwaitingLogon | State::LogonSent);
        if awaiting_logon && kind != msg_type::LOGON {
            actions.push(Action::Disconnect(format!(
                "first message must be Logon, got MsgType {kind}"
            )));
            return actions;
        }

        // Two messages override the sequence number check: a Logon asking to reset, and an
        // administrative SequenceReset. Both say "the numbering starts again here".
        if kind == msg_type::LOGON && message.get_bool(RESET_SEQ_NUM_FLAG) {
            self.next_in = seq;
            self.next_out = 1;
            self.outbound.clear();
            self.unsaved.clear();
            self.reset = true;
            self.dirty = true;
        }
        if kind == msg_type::SEQUENCE_RESET && !message.get_bool(GAP_FILL_FLAG) {
            self.sequence_reset(&message, seq, now, &mut actions);
            return actions;
        }

        if seq < self.next_in {
            if !message.get_bool(POSS_DUP_FLAG) {
                let text = format!(
                    "MsgSeqNum too low: expected {}, received {seq}",
                    self.next_in
                );
                self.fail(&text, now, &mut actions);
            }
            // A possible duplicate we have already processed: ignore it.
            return actions;
        }

        if seq > self.next_in {
            // Messages are missing. The ones that must still be acted on straight away are
            // a Logon (otherwise we could never log on after an outage), a ResendRequest
            // (they are owed our messages regardless of what we are owed) and a Logout.
            // Everything else is dropped and will come back in the resend.
            match kind.as_str() {
                msg_type::LOGON => self.on_logon(&message, now, &mut actions),
                msg_type::RESEND_REQUEST => self.serve_resend(&message, now, &mut actions),
                msg_type::LOGOUT => {
                    self.on_logout(now, &mut actions);
                    return actions;
                }
                _ => {}
            }
            self.request_resend(seq, now, &mut actions);
            return actions;
        }

        // seq == next_in: the message we were waiting for.
        if let Err(violation) = Dictionary::fix44().validate(&message) {
            self.advance_in(seq + 1);
            let mut reject = Message::new(msg_type::REJECT)
                .with(REF_SEQ_NUM, seq.to_string())
                .with(REF_MSG_TYPE, kind)
                .with(SESSION_REJECT_REASON, violation.reason.to_string())
                .with(TEXT, violation.text);
            if let Some(tag) = violation.tag {
                reject.set(REF_TAG_ID, tag.to_string());
            }
            self.send_admin(reject, now, &mut actions);
            return actions;
        }

        if kind == msg_type::SEQUENCE_RESET {
            // Gap fill: the counterparty is skipping numbers it chose not to resend.
            let new_seq = message.get_u64(NEW_SEQ_NO).unwrap_or(0);
            if new_seq > seq {
                self.advance_in(new_seq);
            } else {
                self.advance_in(seq + 1);
                self.reject(
                    seq,
                    &kind,
                    reason::VALUE_IS_INCORRECT,
                    "NewSeqNo must be higher than MsgSeqNum",
                    now,
                    &mut actions,
                );
            }
            self.check_resend_complete();
            return actions;
        }

        self.advance_in(seq + 1);
        self.check_resend_complete();

        match kind.as_str() {
            msg_type::LOGON => self.on_logon(&message, now, &mut actions),
            msg_type::HEARTBEAT => {}
            msg_type::TEST_REQUEST => {
                let id = message.get(TEST_REQ_ID).unwrap_or_default().to_string();
                let heartbeat = Message::new(msg_type::HEARTBEAT).with(TEST_REQ_ID, id);
                self.send_admin(heartbeat, now, &mut actions);
            }
            msg_type::RESEND_REQUEST => self.serve_resend(&message, now, &mut actions),
            msg_type::LOGOUT => self.on_logout(now, &mut actions),
            // A session-level Reject of something we sent: the application decides what it
            // means, so pass it on.
            _ => actions.push(Action::Deliver(message)),
        }
        actions
    }

    fn on_logon(&mut self, message: &Message, now: UtcMillis, actions: &mut Vec<Action>) {
        match (self.config.role, self.state) {
            (Role::Acceptor, State::AwaitingLogon) => {
                let heartbeat_secs = message.get_u64(HEART_BT_INT).unwrap_or(30);
                self.heartbeat_ms = heartbeat_secs * 1000;
                let mut reply = Message::new(msg_type::LOGON)
                    .with(ENCRYPT_METHOD, "0")
                    .with(HEART_BT_INT, heartbeat_secs.to_string());
                if message.get_bool(RESET_SEQ_NUM_FLAG) {
                    reply.set(RESET_SEQ_NUM_FLAG, "Y");
                }
                self.state = State::Active;
                self.send_admin(reply, now, actions);
            }
            (Role::Initiator, State::LogonSent) => {
                if let Some(secs) = message.get_u64(HEART_BT_INT) {
                    self.heartbeat_ms = secs * 1000;
                }
                self.state = State::Active;
            }
            _ => self.fail("unexpected Logon on an active session", now, actions),
        }
    }

    fn on_logout(&mut self, now: UtcMillis, actions: &mut Vec<Action>) {
        if self.state != State::LogoutSent {
            self.send_admin(Message::new(msg_type::LOGOUT), now, actions);
        }
        actions.push(Action::Disconnect("logged out".into()));
    }

    fn sequence_reset(
        &mut self,
        message: &Message,
        seq: u64,
        now: UtcMillis,
        actions: &mut Vec<Action>,
    ) {
        match message.get_u64(NEW_SEQ_NO) {
            Some(new_seq) if new_seq >= self.next_in => {
                self.advance_in(new_seq);
                self.check_resend_complete();
            }
            _ => self.reject(
                seq,
                msg_type::SEQUENCE_RESET,
                reason::VALUE_IS_INCORRECT,
                "SequenceReset may not move the sequence number backwards",
                now,
                actions,
            ),
        }
    }

    fn request_resend(&mut self, seen: u64, now: UtcMillis, actions: &mut Vec<Action>) {
        let already_asked = self.resend_until.is_some();
        self.resend_until = Some(self.resend_until.map_or(seen, |until| until.max(seen)));
        if !already_asked {
            // EndSeqNo 0 means "everything from BeginSeqNo onwards".
            let request = Message::new(msg_type::RESEND_REQUEST)
                .with(BEGIN_SEQ_NO, self.next_in.to_string())
                .with(END_SEQ_NO, "0");
            self.send_admin(request, now, actions);
        }
    }

    fn check_resend_complete(&mut self) {
        if self.resend_until.is_some_and(|until| self.next_in > until) {
            self.resend_until = None;
        }
    }

    /// Replays what we sent from `BeginSeqNo` to `EndSeqNo`. Application messages go again,
    /// marked `PossDupFlag=Y` so the counterparty can tell them from new ones. Session
    /// messages (heartbeats and the like) are never replayed: runs of them are covered by one
    /// `SequenceReset` gap fill.
    fn serve_resend(&mut self, request: &Message, now: UtcMillis, actions: &mut Vec<Action>) {
        let last_sent = self.next_out - 1;
        let begin = request.get_u64(BEGIN_SEQ_NO).unwrap_or(1).max(1);
        let end = match request.get_u64(END_SEQ_NO) {
            Some(0) | None => last_sent,
            Some(end) => end.min(last_sent),
        };

        let mut gap_start: Option<u64> = None;
        for seq in begin..=end {
            let original =
                self.outbound
                    .get(&seq)
                    .and_then(|raw| match codec::decode(&mut raw.clone()) {
                        Some(Decoded::Message(message))
                            if !msg_type::is_admin(message.msg_type()) =>
                        {
                            Some(message)
                        }
                        _ => None,
                    });
            match original {
                None => {
                    gap_start.get_or_insert(seq);
                }
                Some(mut message) => {
                    if let Some(start) = gap_start.take() {
                        self.send_gap_fill(start, seq, now, actions);
                    }
                    let original_time = message.get(SENDING_TIME).unwrap_or_default().to_string();
                    message.set(POSS_DUP_FLAG, "Y");
                    message.set(ORIG_SENDING_TIME, original_time);
                    message.set(SENDING_TIME, now.to_fix());
                    order_header(&mut message);
                    actions.push(Action::Send(codec::encode(&message)));
                    self.last_sent = now;
                }
            }
        }
        if let Some(start) = gap_start {
            self.send_gap_fill(start, end + 1, now, actions);
        }
    }

    fn send_gap_fill(&mut self, from: u64, to: u64, now: UtcMillis, actions: &mut Vec<Action>) {
        let mut fill = Message::new(msg_type::SEQUENCE_RESET)
            .with(SENDER_COMP_ID, self.config.our_comp_id.clone())
            .with(TARGET_COMP_ID, self.config.their_comp_id.clone())
            .with(MSG_SEQ_NUM, from.to_string())
            .with(SENDING_TIME, now.to_fix())
            .with(POSS_DUP_FLAG, "Y")
            .with(GAP_FILL_FLAG, "Y")
            .with(NEW_SEQ_NO, to.to_string());
        order_header(&mut fill);
        actions.push(Action::Send(codec::encode(&fill)));
        self.last_sent = now;
    }

    fn reject(
        &mut self,
        ref_seq: u64,
        ref_msg_type: &str,
        why: u32,
        text: &str,
        now: UtcMillis,
        actions: &mut Vec<Action>,
    ) {
        let reject = Message::new(msg_type::REJECT)
            .with(REF_SEQ_NUM, ref_seq.to_string())
            .with(REF_MSG_TYPE, ref_msg_type)
            .with(SESSION_REJECT_REASON, why.to_string())
            .with(TEXT, text);
        self.send_admin(reject, now, actions);
    }

    /// A protocol error we cannot recover from: say why, and hang up.
    fn fail(&mut self, text: &str, now: UtcMillis, actions: &mut Vec<Action>) {
        if matches!(self.state, State::Active | State::LogoutSent) {
            let logout = Message::new(msg_type::LOGOUT).with(TEXT, text);
            self.send_admin(logout, now, actions);
        }
        actions.push(Action::Disconnect(text.to_string()));
    }

    fn advance_in(&mut self, next: u64) {
        self.next_in = next;
        self.dirty = true;
    }

    fn send_admin(&mut self, message: Message, now: UtcMillis, actions: &mut Vec<Action>) {
        let connected = self.state != State::Disconnected;
        self.stamp_and_store(message, now, connected, actions);
    }

    /// Gives a message our header and the next sequence number, stores it for resend, and
    /// sends it if `connected`.
    fn stamp_and_store(
        &mut self,
        mut message: Message,
        now: UtcMillis,
        connected: bool,
        actions: &mut Vec<Action>,
    ) {
        let seq = self.next_out;
        message.set(SENDER_COMP_ID, self.config.our_comp_id.clone());
        message.set(TARGET_COMP_ID, self.config.their_comp_id.clone());
        message.set(MSG_SEQ_NUM, seq.to_string());
        message.set(SENDING_TIME, now.to_fix());
        order_header(&mut message);
        let bytes = codec::encode(&message);

        self.outbound.insert(seq, bytes.clone());
        self.unsaved.push(seq);
        self.next_out += 1;
        self.dirty = true;
        if connected {
            self.last_sent = now;
            actions.push(Action::Send(bytes));
        }
    }
}

fn order_header(message: &mut Message) {
    message.order_header_first(&[
        SENDER_COMP_ID,
        TARGET_COMP_ID,
        MSG_SEQ_NUM,
        SENDING_TIME,
        POSS_DUP_FLAG,
        ORIG_SENDING_TIME,
    ]);
}
