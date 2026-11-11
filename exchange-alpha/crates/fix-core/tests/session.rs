//! Session layer behaviour: logon, heartbeats, gaps, resend and recovery.
//!
//! Most tests drive an acceptor ("ALPHA") with hand-built messages from a pretend client, so
//! each rule is checked in isolation. The last few connect a real initiator to a real
//! acceptor and pass bytes between them.

use fix_core::tags::*;
use fix_core::*;

const T0: UtcMillis = UtcMillis(1_788_791_531_000);

fn at(seconds: u64) -> UtcMillis {
    UtcMillis(T0.0 + seconds * 1000)
}

fn acceptor() -> Session {
    Session::new(SessionConfig {
        our_comp_id: "ALPHA".into(),
        their_comp_id: "BROKER".into(),
        role: Role::Acceptor,
        heartbeat_secs: 30,
    })
}

fn initiator() -> Session {
    Session::new(SessionConfig {
        our_comp_id: "BROKER".into(),
        their_comp_id: "ALPHA".into(),
        role: Role::Initiator,
        heartbeat_secs: 30,
    })
}

/// A message from the pretend client, with a valid header.
fn from_client(seq: u64, msg_type: &str) -> Message {
    Message::new(msg_type)
        .with(SENDER_COMP_ID, "BROKER")
        .with(TARGET_COMP_ID, "ALPHA")
        .with(MSG_SEQ_NUM, seq.to_string())
        .with(SENDING_TIME, T0.to_fix())
}

fn logon(seq: u64) -> Message {
    from_client(seq, "A")
        .with(ENCRYPT_METHOD, "0")
        .with(HEART_BT_INT, "30")
}

fn new_order(seq: u64, id: &str) -> Message {
    from_client(seq, "D")
        .with(CL_ORD_ID, id)
        .with(ACCOUNT, "acct")
        .with(SYMBOL, "ACME")
        .with(SIDE, "1")
        .with(TRANSACT_TIME, T0.to_fix())
        .with(ORDER_QTY, "100")
        .with(ORD_TYPE, "2")
        .with(PRICE, "42.10")
}

fn sent(actions: &[Action]) -> Vec<Message> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Send(bytes) => match decode(&mut bytes.clone()) {
                Some(Decoded::Message(message)) => Some(message),
                other => panic!("session sent something undecodable: {other:?}"),
            },
            _ => None,
        })
        .collect()
}

fn delivered(actions: &[Action]) -> Vec<Message> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Deliver(message) => Some(message.clone()),
            _ => None,
        })
        .collect()
}

fn disconnected(actions: &[Action]) -> bool {
    actions.iter().any(|a| matches!(a, Action::Disconnect(_)))
}

/// An acceptor that has completed logon with the client at sequence 1.
fn logged_on() -> Session {
    let mut session = acceptor();
    session.on_connected(T0);
    session.receive(logon(1), T0);
    assert!(session.is_active());
    session
}

#[test]
fn acceptor_answers_logon_with_its_own_logon() {
    let mut session = acceptor();
    session.on_connected(T0);
    let actions = session.receive(logon(1), T0);

    let reply = &sent(&actions)[0];
    assert_eq!(reply.msg_type(), "A");
    assert_eq!(reply.get(HEART_BT_INT), Some("30"));
    assert_eq!(reply.get(MSG_SEQ_NUM), Some("1"));
    assert_eq!(reply.get(SENDER_COMP_ID), Some("ALPHA"));
    assert!(session.is_active());
    assert_eq!(session.next_in_seq(), 2);
}

#[test]
fn the_first_message_must_be_a_logon() {
    let mut session = acceptor();
    session.on_connected(T0);
    let actions = session.receive(new_order(1, "o1"), T0);

    assert!(disconnected(&actions));
    assert!(delivered(&actions).is_empty());
}

#[test]
fn messages_for_another_session_are_refused() {
    let mut session = acceptor();
    session.on_connected(T0);
    let impostor = logon(1).with(SENDER_COMP_ID, "SOMEONE-ELSE");
    assert!(disconnected(&session.receive(impostor, T0)));
}

#[test]
fn application_messages_are_delivered_in_order() {
    let mut session = logged_on();
    let first = delivered(&session.receive(new_order(2, "o1"), T0));
    let second = delivered(&session.receive(new_order(3, "o2"), T0));

    assert_eq!(first[0].get(CL_ORD_ID), Some("o1"));
    assert_eq!(second[0].get(CL_ORD_ID), Some("o2"));
    assert_eq!(session.next_in_seq(), 4);
}

#[test]
fn a_test_request_is_answered_with_its_id() {
    let mut session = logged_on();
    let actions = session.receive(from_client(2, "1").with(TEST_REQ_ID, "are-you-there"), T0);

    let reply = &sent(&actions)[0];
    assert_eq!(reply.msg_type(), "0");
    assert_eq!(reply.get(TEST_REQ_ID), Some("are-you-there"));
}

#[test]
fn a_quiet_session_sends_heartbeats() {
    let mut session = logged_on();
    session.receive(from_client(2, "0"), at(29)); // the client is talking, we are not
    assert!(sent(&session.tick(at(29))).is_empty());

    let heartbeats = sent(&session.tick(at(30)));
    assert_eq!(heartbeats.len(), 1);
    assert_eq!(heartbeats[0].msg_type(), "0");
}

#[test]
fn a_silent_counterparty_is_tested_then_dropped() {
    let mut session = logged_on();
    // Heartbeat interval 30s; after 30s + 20% of silence we ask if they are there.
    let probe = sent(&session.tick(at(36)));
    assert!(probe.iter().any(|m| m.msg_type() == "1"), "{probe:?}");

    assert!(
        !disconnected(&session.tick(at(50))),
        "still within the grace period"
    );
    assert!(
        disconnected(&session.tick(at(66))),
        "no answer after a full interval"
    );
}

#[test]
fn an_answer_to_the_test_request_keeps_the_session_alive() {
    let mut session = logged_on();
    session.tick(at(36));
    session.receive(from_client(2, "0").with(TEST_REQ_ID, "TEST-1"), at(40));
    assert!(!disconnected(&session.tick(at(66))));
}

#[test]
fn a_gap_triggers_a_resend_request_and_holds_later_messages_back() {
    let mut session = logged_on();
    session.receive(new_order(2, "o2"), T0);
    // 3 never arrives
    let actions = session.receive(new_order(4, "o4"), T0);

    let request = &sent(&actions)[0];
    assert_eq!(request.msg_type(), "2");
    assert_eq!(request.get(BEGIN_SEQ_NO), Some("3"));
    assert_eq!(request.get(END_SEQ_NO), Some("0"));
    assert!(
        delivered(&actions).is_empty(),
        "4 must not jump the queue ahead of 3"
    );
    assert_eq!(session.next_in_seq(), 3);

    // The resend arrives: 3 then 4, both marked as possible duplicates.
    let three = delivered(&session.receive(new_order(3, "o3").with(POSS_DUP_FLAG, "Y"), T0));
    let four = delivered(&session.receive(new_order(4, "o4").with(POSS_DUP_FLAG, "Y"), T0));
    assert_eq!(three[0].get(CL_ORD_ID), Some("o3"));
    assert_eq!(four[0].get(CL_ORD_ID), Some("o4"));
    assert_eq!(session.next_in_seq(), 5);
}

#[test]
fn a_second_gap_message_does_not_ask_again() {
    let mut session = logged_on();
    session.receive(new_order(3, "o3"), T0);
    let actions = session.receive(new_order(4, "o4"), T0);
    assert!(
        sent(&actions).is_empty(),
        "already waiting on the first resend"
    );
}

#[test]
fn a_sequence_number_that_is_too_low_ends_the_session() {
    let mut session = logged_on();
    session.receive(new_order(2, "o2"), T0);
    let actions = session.receive(new_order(2, "again"), T0);

    assert_eq!(sent(&actions)[0].msg_type(), "5");
    assert!(disconnected(&actions));
}

#[test]
fn a_possible_duplicate_we_already_have_is_ignored() {
    let mut session = logged_on();
    session.receive(new_order(2, "o2"), T0);
    let actions = session.receive(new_order(2, "o2").with(POSS_DUP_FLAG, "Y"), T0);
    assert!(actions.is_empty());
}

#[test]
fn a_gap_fill_skips_the_sequence_number_forward() {
    let mut session = logged_on();
    let actions = session.receive(
        from_client(2, "4")
            .with(GAP_FILL_FLAG, "Y")
            .with(NEW_SEQ_NO, "10")
            .with(POSS_DUP_FLAG, "Y"),
        T0,
    );
    assert!(actions.is_empty());
    assert_eq!(session.next_in_seq(), 10);
}

#[test]
fn an_invalid_message_is_rejected_but_still_uses_its_sequence_number() {
    let mut session = logged_on();
    let mut bad = new_order(2, "o2");
    bad.remove(SYMBOL);
    let actions = session.receive(bad, T0);

    let reject = &sent(&actions)[0];
    assert_eq!(reject.msg_type(), "3");
    assert_eq!(reject.get(REF_SEQ_NUM), Some("2"));
    assert_eq!(reject.get(REF_TAG_ID), Some("55"));
    assert_eq!(reject.get(SESSION_REJECT_REASON), Some("1")); // required tag missing
    assert!(delivered(&actions).is_empty());
    assert_eq!(session.next_in_seq(), 3);
}

#[test]
fn a_resend_replays_application_messages_and_gap_fills_the_rest() {
    let mut session = logged_on(); // our seq 1 was the Logon reply
    session.send(
        Message::new("8").with(ORDER_ID, "A-1").with(TEXT, "first"),
        at(1),
    ); // 2
    session.tick(at(31)); // 3: heartbeat
    session.send(
        Message::new("8").with(ORDER_ID, "A-2").with(TEXT, "second"),
        at(40),
    ); // 4

    let request = from_client(2, "2")
        .with(BEGIN_SEQ_NO, "1")
        .with(END_SEQ_NO, "0");
    let replayed = sent(&session.receive(request, at(50)));

    let summary: Vec<(String, &str, Option<&str>)> = replayed
        .iter()
        .map(|m| {
            (
                m.get(MSG_SEQ_NUM).unwrap().to_string(),
                m.msg_type(),
                m.get(NEW_SEQ_NO),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("1".to_string(), "4", Some("2")), // Logon is never replayed: gap fill
            ("2".to_string(), "8", None),
            ("3".to_string(), "4", Some("4")), // nor a heartbeat
            ("4".to_string(), "8", None),
        ]
    );
    for message in &replayed {
        assert_eq!(message.get(POSS_DUP_FLAG), Some("Y"));
    }
    let first = &replayed[1];
    assert_eq!(first.get(TEXT), Some("first"));
    assert_eq!(first.get(ORIG_SENDING_TIME), Some(at(1).to_fix().as_str()));
    assert_eq!(first.get(SENDING_TIME), Some(at(50).to_fix().as_str()));
}

#[test]
fn logon_with_reset_starts_both_sides_again_at_one() {
    let mut session = logged_on();
    session.send(Message::new("8").with(ORDER_ID, "A-1"), T0);
    session.on_disconnected();

    session.on_connected(at(5));
    let actions = session.receive(logon(1).with(RESET_SEQ_NUM_FLAG, "Y"), at(5));

    let reply = &sent(&actions)[0];
    assert_eq!(reply.get(MSG_SEQ_NUM), Some("1"));
    assert_eq!(reply.get(RESET_SEQ_NUM_FLAG), Some("Y"));
    assert_eq!(session.next_in_seq(), 2);
    assert!(session.take_changes().unwrap().reset);
}

#[test]
fn a_logout_is_answered_and_the_connection_closed() {
    let mut session = logged_on();
    let actions = session.receive(from_client(2, "5"), T0);
    assert_eq!(sent(&actions)[0].msg_type(), "5");
    assert!(disconnected(&actions));
}

#[test]
fn changes_report_what_needs_persisting() {
    let mut session = logged_on();
    let changes = session.take_changes().expect("logon changed state");
    assert_eq!(changes.next_in_seq, 2);
    assert_eq!(changes.next_out_seq, 2);
    assert_eq!(changes.new_outbound.len(), 1);
    assert_eq!(session.take_changes(), None, "nothing new since");
}

/// Passes every `Send` from one session to the other until both go quiet, collecting what
/// each delivers to its application.
fn pump(
    initiator: &mut Session,
    acceptor: &mut Session,
    mut to_acceptor: Vec<Action>,
    now: UtcMillis,
) -> (Vec<Message>, Vec<Message>) {
    let (mut at_initiator, mut at_acceptor) = (Vec::new(), Vec::new());
    let mut to_initiator = Vec::new();
    for _ in 0..100 {
        if to_acceptor.is_empty() && to_initiator.is_empty() {
            break;
        }
        for action in std::mem::take(&mut to_acceptor) {
            if let Action::Send(mut bytes) = action {
                while let Some(Decoded::Message(m)) = decode(&mut bytes) {
                    for reply in acceptor.receive(m, now) {
                        match reply {
                            Action::Deliver(m) => at_acceptor.push(m),
                            other => to_initiator.push(other),
                        }
                    }
                }
            }
        }
        for action in std::mem::take(&mut to_initiator) {
            if let Action::Send(mut bytes) = action {
                while let Some(Decoded::Message(m)) = decode(&mut bytes) {
                    for reply in initiator.receive(m, now) {
                        match reply {
                            Action::Deliver(m) => at_initiator.push(m),
                            other => to_acceptor.push(other),
                        }
                    }
                }
            }
        }
    }
    (at_initiator, at_acceptor)
}

fn report(order_id: &str) -> Message {
    Message::new("8")
        .with(ORDER_ID, order_id)
        .with(EXEC_ID, format!("E-{order_id}"))
        .with(EXEC_TYPE, "0")
        .with(ORD_STATUS, "0")
        .with(SYMBOL, "ACME")
        .with(SIDE, "1")
        .with(LEAVES_QTY, "100")
        .with(CUM_QTY, "0")
        .with(AVG_PX, "0")
}

#[test]
fn an_initiator_and_an_acceptor_log_on_to_each_other() {
    let (mut client, mut exchange) = (initiator(), acceptor());
    exchange.on_connected(T0);
    let hello = client.on_connected(T0);
    pump(&mut client, &mut exchange, hello, T0);

    assert!(client.is_active());
    assert!(exchange.is_active());
}

#[test]
fn reports_sent_while_the_client_was_away_arrive_by_resend_after_logon() {
    let (mut client, mut exchange) = (initiator(), acceptor());
    exchange.on_connected(T0);
    let hello = client.on_connected(T0);
    pump(&mut client, &mut exchange, hello, T0);

    // The client drops off. Two reports are produced for it while it is gone.
    client.on_disconnected();
    exchange.on_disconnected();
    assert!(
        exchange.send(report("ALPHA-1"), at(1)).is_empty(),
        "nowhere to send it"
    );
    assert!(exchange.send(report("ALPHA-2"), at(2)).is_empty());

    // It comes back. The exchange's Logon reply carries a sequence number higher than the
    // client expects, the client asks for the gap, and both reports arrive marked PossDup.
    exchange.on_connected(at(10));
    let hello = client.on_connected(at(10));
    let (at_client, _) = pump(&mut client, &mut exchange, hello, at(10));

    let ids: Vec<&str> = at_client.iter().map(|m| m.get(ORDER_ID).unwrap()).collect();
    assert_eq!(ids, ["ALPHA-1", "ALPHA-2"]);
    assert!(at_client.iter().all(|m| m.get(POSS_DUP_FLAG) == Some("Y")));
    assert_eq!(
        client.next_in_seq(),
        exchange.next_out_seq(),
        "fully caught up"
    );
}

#[test]
fn a_restored_session_resumes_its_sequence_numbers() {
    let mut original = logged_on();
    original.send(report("ALPHA-1"), T0);
    let changes = original.take_changes().unwrap();

    let restored = Session::restore(
        original.config().clone(),
        changes.next_in_seq,
        changes.next_out_seq,
        changes.new_outbound,
    );
    assert_eq!(restored.next_in_seq(), 2);
    assert_eq!(restored.next_out_seq(), 3);
}
