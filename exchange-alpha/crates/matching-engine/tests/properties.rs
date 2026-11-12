//! Property tests: generate thousands of random command sequences and check the rules that
//! must hold for every one of them, not just the cases someone thought to write down.
//!
//! The generator keeps prices in a narrow band and uses only three participants, so orders
//! cross, rest, partially fill, self-trade and get cancelled constantly.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use matching_engine::*;
use proptest::prelude::*;

fn participant() -> impl Strategy<Value = String> {
    prop::sample::select(vec!["p1", "p2", "p3"]).prop_map(String::from)
}

fn order_type() -> impl Strategy<Value = OrderType> {
    prop_oneof![
        5 => (9_990i64..=10_010).prop_map(|cents| OrderType::Limit { price: PriceCents(cents) }),
        1 => Just(OrderType::Market),
    ]
}

fn time_in_force() -> impl Strategy<Value = TimeInForce> {
    prop::sample::select(vec![
        TimeInForce::Day,
        TimeInForce::Gtc,
        TimeInForce::Gtc,
        TimeInForce::Ioc,
        TimeInForce::Fok,
    ])
}

fn command() -> impl Strategy<Value = Command> {
    let new_order = (
        participant(),
        prop::sample::select(vec!["ACME", "BLTZ"]),
        any::<bool>(),
        order_type(),
        time_in_force(),
        -2i64..60, // includes zero and negatives, to exercise rejection
    )
        .prop_map(
            |(participant, symbol, buy, order_type, time_in_force, qty)| {
                Command::New(NewOrder {
                    client_order_id: "c".into(),
                    participant,
                    symbol: symbol.into(),
                    side: if buy { Side::Buy } else { Side::Sell },
                    order_type,
                    time_in_force,
                    qty: Qty(qty),
                })
            },
        );
    let cancel = (participant(), 1u64..80).prop_map(|(participant, id)| {
        Command::Cancel(CancelOrder {
            participant,
            order_id: OrderId(id),
        })
    });
    let end_of_day = Just(Command::EndOfDay(EndOfDay {
        business_date: "2026-11-12".into(),
    }));
    prop_oneof![40 => new_order, 10 => cancel, 1 => end_of_day]
}

fn temp_journal() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("me-prop-{}-{n}.journal", std::process::id()))
}

/// What happened to one order, reconstructed purely from the event stream.
#[derive(Default)]
struct OrderHistory {
    original: i64,
    traded: i64,
    cancelled: i64,
    side: Option<Side>,
    limit: Option<PriceCents>,
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    /// The headline property: replaying the journal rebuilds a byte-identical engine.
    #[test]
    fn replaying_the_journal_rebuilds_a_byte_identical_engine(
        commands in prop::collection::vec(command(), 0..300)
    ) {
        let path = temp_journal();
        let mut live = JournaledEngine::open(&path).unwrap();
        for command in commands {
            live.submit(command).unwrap();
        }
        let recovered = JournaledEngine::open(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        let live_bytes = serde_json::to_vec(&live.engine().snapshot()).unwrap();
        let recovered_bytes = serde_json::to_vec(&recovered.engine().snapshot()).unwrap();
        prop_assert_eq!(live_bytes, recovered_bytes);
        prop_assert_eq!(live.engine(), recovered.engine());
    }

    /// Straight after a close, nothing on any book is a day order.
    #[test]
    fn no_day_order_survives_the_close(commands in prop::collection::vec(command(), 0..300)) {
        let mut engine = Engine::default();
        for command in commands {
            engine.apply(command);
        }
        engine.apply(Command::EndOfDay(EndOfDay { business_date: "2026-11-12".into() }));
        for book in engine.snapshot().books {
            for level in book.bids.iter().chain(&book.asks) {
                for order in &level.orders {
                    prop_assert_ne!(order.time_in_force, TimeInForce::Day);
                }
            }
        }
    }

    /// A restored engine is the engine that took the snapshot, and carries on identically.
    #[test]
    fn a_restored_engine_is_the_same_engine(
        before in prop::collection::vec(command(), 0..200),
        after in prop::collection::vec(command(), 0..100),
    ) {
        let mut original = Engine::default();
        for command in before {
            original.apply(command);
        }
        let mut restored = Engine::restore(original.snapshot()).unwrap();
        prop_assert_eq!(&restored, &original);
        for command in after {
            prop_assert_eq!(restored.apply(command.clone()), original.apply(command));
        }
        prop_assert_eq!(restored, original);
    }

    /// Recovery from a snapshot plus the journal since, against replaying everything: the
    /// same engine, byte for byte.
    #[test]
    fn snapshot_plus_the_next_journal_equals_a_full_replay(
        day1 in prop::collection::vec(command(), 0..200),
        day2 in prop::collection::vec(command(), 0..200),
    ) {
        let (everything, first, second) = (temp_journal(), temp_journal(), temp_journal());
        let mut full = JournaledEngine::open(&everything).unwrap();
        let mut live = JournaledEngine::open(&first).unwrap();
        for command in &day1 {
            full.submit(command.clone()).unwrap();
            live.submit(command.clone()).unwrap();
        }
        let (snapshot, seq) = (live.engine().snapshot(), live.last_seq());
        let engine = Engine::restore(snapshot.clone()).unwrap();
        let mut live = JournaledEngine::resume_observing(&second, engine, seq, |_| {}).unwrap();
        for command in &day2 {
            full.submit(command.clone()).unwrap();
            live.submit(command.clone()).unwrap();
        }

        let replayed = JournaledEngine::open(&everything).unwrap();
        let engine = Engine::restore(snapshot).unwrap();
        let recovered = JournaledEngine::resume_observing(&second, engine, seq, |_| {}).unwrap();
        for path in [everything, first, second] {
            let _ = std::fs::remove_file(path);
        }

        let replayed_bytes = serde_json::to_vec(&replayed.engine().snapshot()).unwrap();
        let recovered_bytes = serde_json::to_vec(&recovered.engine().snapshot()).unwrap();
        prop_assert_eq!(replayed_bytes, recovered_bytes);
        prop_assert_eq!(recovered.engine(), live.engine());
        prop_assert_eq!(recovered.last_seq(), replayed.last_seq());
    }

    /// Same input, same output: two engines given the same commands emit identical events.
    #[test]
    fn matching_is_deterministic(commands in prop::collection::vec(command(), 0..300)) {
        let mut a = Engine::default();
        let mut b = Engine::default();
        for command in commands {
            prop_assert_eq!(a.apply(command.clone()), b.apply(command));
        }
    }

    #[test]
    fn invariants_hold_after_every_command(commands in prop::collection::vec(command(), 0..300)) {
        let mut engine = Engine::default();
        let mut orders: HashMap<OrderId, OrderHistory> = HashMap::new();

        for command in commands {
            for event in engine.apply(command) {
                match event {
                    Event::Accepted { order_id, side, order_type, qty, .. } => {
                        let history = orders.entry(order_id).or_default();
                        history.original = qty.0;
                        history.side = Some(side);
                        history.limit = order_type.limit_price();
                    }
                    Event::Trade(trade) => {
                        // Never trade at a worse price than the aggressor accepted.
                        let aggressor = &orders[&trade.aggressor_order_id];
                        if let Some(limit) = aggressor.limit {
                            match trade.aggressor_side {
                                Side::Buy => prop_assert!(trade.price <= limit),
                                Side::Sell => prop_assert!(trade.price >= limit),
                            }
                        }
                        // Never let a participant trade with itself.
                        prop_assert_ne!(&trade.aggressor_participant, &trade.resting_participant);
                        prop_assert!(trade.qty.0 > 0);
                        orders.get_mut(&trade.aggressor_order_id).unwrap().traded += trade.qty.0;
                        orders.get_mut(&trade.resting_order_id).unwrap().traded += trade.qty.0;
                    }
                    Event::Canceled { order_id, remaining, .. } => {
                        orders.get_mut(&order_id).unwrap().cancelled += remaining.0;
                    }
                    _ => {}
                }
            }

            // Matching exists to make a crossed book impossible.
            for (symbol, book) in engine.books() {
                prop_assert!(!book.is_crossed(), "{} is crossed", symbol);
            }
        }

        // Every share of every order is accounted for exactly once: traded, cancelled, or
        // still resting. Nothing is created or lost, and nothing fills more than its size.
        let mut resting: HashMap<OrderId, i64> = HashMap::new();
        for book in engine.snapshot().books {
            for level in book.bids.iter().chain(&book.asks) {
                prop_assert_eq!(level.qty.0, level.orders.iter().map(|o| o.remaining.0).sum::<i64>());
                for order in &level.orders {
                    prop_assert!(order.remaining.0 > 0, "an empty order was left in the book");
                    resting.insert(order.order_id, order.remaining.0);
                }
            }
        }
        for (order_id, history) in &orders {
            let still_resting = resting.get(order_id).copied().unwrap_or(0);
            prop_assert!(history.traded <= history.original, "order {} overfilled", order_id);
            prop_assert_eq!(
                history.traded + history.cancelled + still_resting,
                history.original,
                "order {} does not add up", order_id
            );
            prop_assert!(history.side.is_some());
        }
        prop_assert_eq!(resting.len(), engine.resting_order_count());
    }
}
