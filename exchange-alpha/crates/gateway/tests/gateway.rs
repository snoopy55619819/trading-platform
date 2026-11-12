//! The gateway end to end: real TCP, real FIX sessions, real matching engine.

mod common;

use common::*;
use fix_core::tags::*;
use gateway::MemoryStore;

#[tokio::test]
async fn an_order_is_acknowledged_with_a_venue_order_id() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;

    broker.send(limit("o1", "2", "100", "ACME", "42.10")).await;
    let ack = broker.next().await;

    assert_eq!(exec(&ack), ("0", "0")); // New, New
    assert_eq!(ack.get(ORDER_ID), Some("ALPHA-1"));
    assert_eq!(ack.get(CL_ORD_ID), Some("o1"));
    assert_eq!(ack.get(LEAVES_QTY), Some("100"));
    assert_eq!(ack.get(PRICE), Some("42.10"));
}

#[tokio::test]
async fn two_sessions_trade_and_each_sees_only_its_own_side() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    let mut sim = Client::logon(gateway.addr, "SIM").await;

    broker.send(limit("b1", "2", "100", "ACME", "42.10")).await;
    broker.next().await; // ack
    sim.send(limit("s1", "1", "60", "ACME", "42.10")).await;

    // The buyer took liquidity: acked, then filled in full, paying the taker fee.
    assert_eq!(exec(&sim.next().await), ("0", "0"));
    let bought = sim.next().await;
    assert_eq!(exec(&bought), ("F", "2"));
    assert_eq!(bought.get(CL_ORD_ID), Some("s1"));
    assert_eq!(bought.get(LAST_QTY), Some("60"));
    assert_eq!(bought.get(LAST_PX), Some("42.10"));
    assert_eq!(bought.get(AVG_PX), Some("42.1000"));
    assert_eq!(bought.get(LAST_LIQUIDITY_IND), Some("2")); // removed liquidity
    assert_eq!(bought.get(COMMISSION), Some("0.76")); // 3 bps of $2,526.00

    // The resting seller was partially filled and earns the maker rebate.
    let sold = broker.next().await;
    assert_eq!(exec(&sold), ("F", "1"));
    assert_eq!(sold.get(CL_ORD_ID), Some("b1"));
    assert_eq!(sold.get(CUM_QTY), Some("60"));
    assert_eq!(sold.get(LEAVES_QTY), Some("40"));
    assert_eq!(sold.get(LAST_LIQUIDITY_IND), Some("1")); // added liquidity
    assert_eq!(sold.get(COMMISSION), Some("-0.51")); // 2 bps rebate

    // Neither side heard anything about the other's order.
    broker.expect_silence().await;
    sim.expect_silence().await;
}

#[tokio::test]
async fn every_validation_failure_names_its_reason() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;

    // (description, order, expected OrdRejReason)
    let cases = [
        (
            "unknown symbol",
            limit("r1", "1", "10", "NOPE", "10.00"),
            "1",
        ),
        (
            "off-tick price",
            limit("r2", "1", "10", "CRUX", "286.52"),
            "11",
        ),
        (
            "outside the price band",
            limit("r3", "1", "10", "ACME", "60.00"),
            "3",
        ),
        (
            "zero quantity",
            limit("r4", "1", "0", "ACME", "42.10"),
            "13",
        ),
        (
            "fractional shares",
            limit("r5", "1", "10.5", "ACME", "42.10"),
            "13",
        ),
        (
            "sub-cent price",
            limit("r6", "1", "10", "ACME", "42.105"),
            "11",
        ),
        (
            "market order with a price",
            market("r7", "1", "10", "ACME").with(PRICE, "42.10"),
            "11",
        ),
        (
            "limit order without a price",
            {
                let mut order = limit("r8", "1", "10", "ACME", "42.10");
                order.remove(PRICE);
                order
            },
            "11",
        ),
        (
            "wrong venue",
            limit("r9", "1", "10", "ACME", "42.10").with(SECURITY_EXCHANGE, "BETA"),
            "99",
        ),
    ];
    for (description, order, reason) in cases {
        broker.send(order).await;
        let report = broker.next().await;
        assert_eq!(exec(&report), ("8", "8"), "{description}");
        assert_eq!(report.get(ORD_REJ_REASON), Some(reason), "{description}");
        assert_eq!(report.get(ORDER_ID), Some("NONE"), "{description}");
        assert!(report.get(TEXT).is_some(), "{description} explains itself");
    }

    // A ClOrdID can be used once, even if the first order was rejected.
    broker.send(limit("r1", "1", "10", "ACME", "42.10")).await;
    assert_eq!(broker.next().await.get(ORD_REJ_REASON), Some("6"));
}

#[tokio::test]
async fn a_cancel_answers_with_the_cancel_requests_id() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;

    broker.send(limit("o1", "1", "100", "ACME", "42.00")).await;
    broker.next().await;
    broker.send(cancel("c1", "o1", "1", "ACME")).await;

    let canceled = broker.next().await;
    assert_eq!(exec(&canceled), ("4", "4"));
    assert_eq!(canceled.get(CL_ORD_ID), Some("c1"));
    assert_eq!(canceled.get(ORDER_ID), Some("ALPHA-1"));
    assert_eq!(canceled.get(LEAVES_QTY), Some("0"));

    // Cancelling it again is too late.
    broker.send(cancel("c2", "o1", "1", "ACME")).await;
    let refused = broker.next().await;
    assert_eq!(refused.msg_type(), "9");
    assert_eq!(refused.get(CXL_REJ_REASON), Some("0"));
    assert_eq!(refused.get(ORD_STATUS), Some("4")); // canceled
}

#[tokio::test]
async fn a_cancel_for_a_filled_order_is_too_late_and_says_it_filled() {
    // The gateway keeps only a small entry for a finished order, not its full record. It must
    // still answer exactly as before.
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    let mut sim = Client::logon(gateway.addr, "SIM").await;

    broker.send(limit("o1", "2", "50", "ACME", "42.10")).await;
    broker.next().await;
    sim.send(market("s1", "1", "50", "ACME")).await;
    assert_eq!(exec(&broker.next().await), ("F", "2")); // filled in full

    broker.send(cancel("c1", "o1", "2", "ACME")).await;
    let refused = broker.next().await;
    assert_eq!(refused.msg_type(), "9");
    assert_eq!(refused.get(CXL_REJ_REASON), Some("0")); // too late
    assert_eq!(refused.get(ORD_STATUS), Some("2")); // filled
    assert_eq!(refused.get(ORDER_ID), Some("ALPHA-1"));

    // Its ClOrdID is still spent for the day.
    broker.send(limit("o1", "2", "10", "ACME", "42.10")).await;
    assert_eq!(broker.next().await.get(ORD_REJ_REASON), Some("6"));
}

#[tokio::test]
async fn one_session_cannot_cancel_anothers_order() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    let mut sim = Client::logon(gateway.addr, "SIM").await;

    broker.send(limit("o1", "1", "100", "ACME", "42.00")).await;
    broker.next().await;
    // SIM knows (or guesses) BROKER's ClOrdID. ClOrdIDs are scoped per session, so it finds
    // nothing.
    sim.send(cancel("c1", "o1", "1", "ACME")).await;

    let refused = sim.next().await;
    assert_eq!(refused.msg_type(), "9");
    assert_eq!(refused.get(CXL_REJ_REASON), Some("1")); // unknown order
    broker.expect_silence().await;
}

#[tokio::test]
async fn unknown_comp_ids_and_second_sessions_are_refused() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;

    let stranger = tokio::net::TcpStream::connect(gateway.addr).await.unwrap();
    assert_refused(stranger, "MALLORY").await;

    let duplicate = tokio::net::TcpStream::connect(gateway.addr).await.unwrap();
    assert_refused(duplicate, "BROKER").await;

    // The original session is unaffected.
    broker.send(limit("o1", "1", "10", "ACME", "42.00")).await;
    assert_eq!(exec(&broker.next().await), ("0", "0"));
}

async fn assert_refused(mut stream: tokio::net::TcpStream, comp_id: &str) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let logon = fix_core::Message::new("A")
        .with(SENDER_COMP_ID, comp_id)
        .with(TARGET_COMP_ID, "ALPHA")
        .with(MSG_SEQ_NUM, "1")
        .with(SENDING_TIME, fix_core::UtcMillis::now().to_fix())
        .with(ENCRYPT_METHOD, "0")
        .with(HEART_BT_INT, "30");
    stream.write_all(&fix_core::encode(&logon)).await.unwrap();
    let mut buffer = Vec::new();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        stream.read_to_end(&mut buffer),
    )
    .await
    .expect("the gateway should hang up");
    assert!(read.is_ok());
    assert!(buffer.is_empty(), "{comp_id} must get no Logon reply");
}

#[tokio::test]
async fn fills_that_happen_while_a_client_is_away_arrive_by_resend() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    let mut sim = Client::logon(gateway.addr, "SIM").await;

    broker.send(limit("b1", "2", "100", "ACME", "42.10")).await;
    broker.next().await;
    let broker_session = broker.drop_connection(); // the broker's network drops

    // Its resting order fills while it is gone.
    sim.send(market("s1", "1", "100", "ACME")).await;
    sim.next().await;
    assert_eq!(exec(&sim.next().await), ("F", "2"));

    // It reconnects with its old sequence numbers. The gateway's Logon reply shows a gap, the
    // client asks for it, and the fill arrives marked as a possible duplicate.
    let mut broker = Client::reconnect(gateway.addr, broker_session).await;
    let missed = broker.next().await;
    assert_eq!(exec(&missed), ("F", "2"));
    assert_eq!(missed.get(CL_ORD_ID), Some("b1"));
    assert_eq!(missed.get(POSS_DUP_FLAG), Some("Y"));
}

#[tokio::test]
async fn after_a_crash_the_book_and_the_sessions_come_back() {
    let journal = TempData::new();
    let store = MemoryStore::default();

    let gateway = start_gateway(&journal, store.clone()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    broker.send(limit("b1", "2", "100", "ACME", "42.10")).await;
    broker.next().await;
    let broker_session = broker.drop_connection();
    let seq_before = broker_session.next_in_seq();
    gateway.kill(); // no logout, no flush: a crash

    // A new process, the same journal and session store.
    let gateway = start_gateway(&journal, store).await;
    let mut broker = Client::reconnect(gateway.addr, broker_session).await;
    assert_eq!(
        broker.session.next_in_seq(),
        seq_before + 1,
        "sequence numbers resumed: only the Logon reply arrived, nothing was reset or resent"
    );

    // The resting order survived in the book, under the same id.
    let mut sim = Client::logon(gateway.addr, "SIM").await;
    sim.send(market("s1", "1", "30", "ACME")).await;
    let fill = broker.next().await;
    assert_eq!(exec(&fill), ("F", "1"));
    assert_eq!(fill.get(ORDER_ID), Some("ALPHA-1"));
    assert_eq!(fill.get(CL_ORD_ID), Some("b1"));
    assert_eq!(fill.get(LEAVES_QTY), Some("70"));

    // ClOrdIDs used before the crash are still remembered.
    broker.send(limit("b1", "2", "5", "ACME", "42.10")).await;
    assert_eq!(broker.next().await.get(ORD_REJ_REASON), Some("6"));
}
