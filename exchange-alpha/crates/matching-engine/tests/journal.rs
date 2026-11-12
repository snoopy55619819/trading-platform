//! Journal durability and recovery.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use matching_engine::*;

/// A fresh journal path per test, removed when the test finishes.
struct TempJournal(PathBuf);

impl TempJournal {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        Self(std::env::temp_dir().join(format!("me-journal-{}-{n}.journal", std::process::id())))
    }
}

impl Drop for TempJournal {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn sell(who: &str, qty: i64, cents: i64) -> Command {
    Command::New(NewOrder {
        client_order_id: format!("{who}-{qty}"),
        participant: who.into(),
        symbol: "ACME".into(),
        side: Side::Sell,
        order_type: OrderType::Limit {
            price: PriceCents(cents),
        },
        time_in_force: TimeInForce::Gtc,
        qty: Qty(qty),
    })
}

#[test]
fn reopening_the_journal_rebuilds_the_same_engine() {
    let journal = TempJournal::new();
    let mut live = JournaledEngine::open(&journal.0).unwrap();
    live.submit(sell("alice", 100, 4210)).unwrap();
    live.submit(sell("bob", 50, 4211)).unwrap();
    live.submit(Command::Cancel(CancelOrder {
        participant: "alice".into(),
        order_id: OrderId(1),
    }))
    .unwrap();

    let recovered = JournaledEngine::open(&journal.0).unwrap();

    assert_eq!(recovered.recovered(), 3);
    assert_eq!(recovered.engine(), live.engine());
}

#[test]
fn ids_continue_after_recovery_instead_of_restarting() {
    let journal = TempJournal::new();
    {
        let mut first = JournaledEngine::open(&journal.0).unwrap();
        first.submit(sell("alice", 100, 4210)).unwrap();
        first.submit(sell("bob", 100, 4211)).unwrap();
    }

    let mut second = JournaledEngine::open(&journal.0).unwrap();
    let events = second.submit(sell("carol", 100, 4212)).unwrap();

    assert!(matches!(
        events[0],
        Event::Accepted {
            order_id: OrderId(3),
            ..
        }
    ));
}

#[test]
fn a_torn_final_write_is_dropped_and_the_journal_keeps_working() {
    let journal = TempJournal::new();
    {
        let mut live = JournaledEngine::open(&journal.0).unwrap();
        live.submit(sell("alice", 100, 4210)).unwrap();
        live.submit(sell("bob", 100, 4211)).unwrap();
    }
    // A crash part-way through an append leaves half a line with no newline.
    fs::OpenOptions::new()
        .append(true)
        .open(&journal.0)
        .unwrap()
        .write_all(br#"{"seq":3,"command":{"type":"NEW","clie"#)
        .unwrap();

    let mut recovered = JournaledEngine::open(&journal.0).unwrap();
    assert_eq!(recovered.recovered(), 2);

    recovered.submit(sell("carol", 100, 4212)).unwrap();
    let reopened = JournaledEngine::open(&journal.0).unwrap();
    assert_eq!(
        reopened.recovered(),
        3,
        "seq 3 reused cleanly after the torn line"
    );
    assert_eq!(reopened.engine(), recovered.engine());
}

#[test]
fn corruption_in_the_middle_refuses_to_start() {
    let journal = TempJournal::new();
    {
        let mut live = JournaledEngine::open(&journal.0).unwrap();
        live.submit(sell("alice", 100, 4210)).unwrap();
    }
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&journal.0)
        .unwrap();
    file.write_all(b"this is not json\n").unwrap();

    let error = JournaledEngine::open(&journal.0)
        .err()
        .expect("must refuse");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
}

#[test]
fn a_gap_in_sequence_numbers_refuses_to_start() {
    let journal = TempJournal::new();
    fs::write(
        &journal.0,
        concat!(
            r#"{"seq":1,"command":{"type":"CANCEL","participant":"a","order_id":1}}"#,
            "\n",
            r#"{"seq":3,"command":{"type":"CANCEL","participant":"a","order_id":2}}"#,
            "\n",
        ),
    )
    .unwrap();

    let error = JournaledEngine::open(&journal.0)
        .err()
        .expect("must refuse");
    assert!(
        error.to_string().contains("expected seq 2, found 3"),
        "{error}"
    );
}

#[test]
fn rejected_commands_are_journaled_too() {
    let journal = TempJournal::new();
    let mut live = JournaledEngine::open(&journal.0).unwrap();
    live.submit(sell("alice", 0, 4210)).unwrap(); // rejected: zero quantity
    live.submit(sell("bob", 100, 4210)).unwrap();

    let recovered = JournaledEngine::open(&journal.0).unwrap();
    assert_eq!(
        recovered.recovered(),
        2,
        "replay must see exactly what the engine saw"
    );
    assert_eq!(recovered.engine(), live.engine());
}

#[test]
fn opening_can_observe_the_replayed_events() {
    let journal = TempJournal::new();
    {
        let mut live = JournaledEngine::open(&journal.0).unwrap();
        live.submit(sell("alice", 100, 4210)).unwrap();
        live.submit(sell("bob", 50, 4211)).unwrap();
        assert_eq!(live.last_seq(), 2);
    }

    let mut accepted = Vec::new();
    let recovered = JournaledEngine::open_observing(&journal.0, |event| {
        if let Event::Accepted { participant, .. } = event {
            accepted.push(participant.clone());
        }
    })
    .unwrap();

    assert_eq!(accepted, ["alice", "bob"]);
    assert_eq!(
        recovered.last_seq(),
        2,
        "sequence numbering resumes, not restarts"
    );
}

#[test]
fn a_continuing_journal_numbers_on_from_the_day_before() {
    let day1 = TempJournal::new();
    let day2 = TempJournal::new();
    let mut live = JournaledEngine::open(&day1.0).unwrap();
    live.submit(sell("alice", 100, 4210)).unwrap();
    live.submit(sell("bob", 50, 4211)).unwrap();
    let snapshot = live.engine().snapshot();

    let engine = Engine::restore(snapshot).unwrap();
    let mut next = JournaledEngine::resume_observing(&day2.0, engine, 2, |_| {}).unwrap();
    next.submit(sell("carol", 10, 4212)).unwrap();

    assert_eq!(next.last_seq(), 3);
    assert!(
        fs::read_to_string(&day2.0)
            .unwrap()
            .starts_with(r#"{"seq":3,"#)
    );
}

#[test]
fn a_continuing_journal_that_does_not_follow_on_refuses_to_start() {
    let journal = TempJournal::new();
    fs::write(
        &journal.0,
        concat!(
            r#"{"seq":1,"command":{"type":"CANCEL","participant":"a","order_id":1}}"#,
            "\n",
        ),
    )
    .unwrap();

    let error = JournaledEngine::resume_observing(&journal.0, Engine::default(), 7, |_| {})
        .err()
        .expect("must refuse");
    assert!(
        error.to_string().contains("expected seq 8, found 1"),
        "{error}"
    );
}

#[test]
fn a_snapshot_that_does_not_add_up_is_refused() {
    let mut engine = Engine::default();
    engine.apply(sell("alice", 100, 4210));
    let mut snapshot = engine.snapshot();
    snapshot.books[0].asks[0].qty = Qty(99);

    let error = Engine::restore(snapshot).expect_err("must refuse");
    assert!(error.contains("level total 99"), "{error}");
}

#[test]
fn a_snapshot_with_an_order_above_the_id_counter_is_refused() {
    let mut engine = Engine::default();
    engine.apply(sell("alice", 100, 4210));
    let mut snapshot = engine.snapshot();
    snapshot.last_order_id = 0;

    assert!(Engine::restore(snapshot).is_err());
}

#[test]
fn a_new_days_journal_continues_the_numbering() {
    let day1 = TempJournal::new();
    let day2 = TempJournal::new();
    let mut live = JournaledEngine::open(&day1.0).unwrap();
    live.submit(sell("alice", 100, 4210)).unwrap();

    live.continue_in(&day2.0).unwrap();
    live.submit(sell("bob", 50, 4211)).unwrap();

    assert_eq!(live.last_seq(), 2);
    assert!(
        fs::read_to_string(&day2.0)
            .unwrap()
            .starts_with(r#"{"seq":2,"#)
    );
    assert_eq!(fs::read_to_string(&day1.0).unwrap().lines().count(), 1);
}
