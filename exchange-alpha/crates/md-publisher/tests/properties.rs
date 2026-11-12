//! Property tests: random order flow through the real engine, out through the feed, into
//! subscribers' mirrors. For every generated sequence:
//!
//! - a subscriber that joins at any point, from a snapshot, ends with exactly the engine's
//!   book, built from nothing but feed messages;
//! - `feed_seq` and every symbol's `symbol_seq` count up by one with no gaps;
//! - no participant name appears anywhere in the bytes sent.

use std::collections::HashMap;

use matching_engine::*;
use md_publisher::proto::{self, FeedMessage, feed_message};
use md_publisher::{Applied, Feed, Mirror, PublicEvent};
use proptest::prelude::*;
use prost::Message as _;

const SYMBOLS: [&str; 2] = ["ACME", "BLTZ"];
// Long, distinctive names, so finding one in the encoded bytes cannot be a coincidence.
const PARTICIPANTS: [&str; 3] = ["SECRET-FIRM-ONE", "SECRET-FIRM-TWO", "SECRET-FIRM-THREE"];

fn command() -> impl Strategy<Value = Command> {
    let new_order = (
        prop::sample::select(PARTICIPANTS.to_vec()),
        prop::sample::select(SYMBOLS.to_vec()),
        any::<bool>(),
        prop_oneof![
            5 => (9_990i64..=10_010).prop_map(|c| OrderType::Limit { price: PriceCents(c) }),
            1 => Just(OrderType::Market),
        ],
        prop::sample::select(vec![
            TimeInForce::Gtc,
            TimeInForce::Gtc,
            TimeInForce::Ioc,
            TimeInForce::Fok,
        ]),
        1i64..60,
    )
        .prop_map(
            |(participant, symbol, buy, order_type, time_in_force, qty)| {
                Command::New(NewOrder {
                    client_order_id: "c".into(),
                    participant: participant.into(),
                    symbol: symbol.into(),
                    side: if buy { Side::Buy } else { Side::Sell },
                    order_type,
                    time_in_force,
                    qty: Qty(qty),
                })
            },
        );
    let cancel =
        (prop::sample::select(PARTICIPANTS.to_vec()), 1u64..80).prop_map(|(participant, id)| {
            Command::Cancel(CancelOrder {
                participant: participant.into(),
                order_id: OrderId(id),
            })
        });
    prop_oneof![4 => new_order, 1 => cancel]
}

fn snapshot_message(feed: &Feed, symbol: &str) -> FeedMessage {
    FeedMessage {
        payload: Some(feed_message::Payload::Snapshot(
            feed.snapshot(symbol, md_publisher::feed::MAX_DEPTH, 0)
                .unwrap(),
        )),
    }
}

fn sequence_numbers(message: &FeedMessage) -> (String, u64, u64) {
    match &message.payload {
        Some(feed_message::Payload::BookDelta(m)) => (m.symbol.clone(), m.feed_seq, m.symbol_seq),
        Some(feed_message::Payload::TradePrint(m)) => (m.symbol.clone(), m.feed_seq, m.symbol_seq),
        other => panic!("publish returned an unsequenced message: {other:?}"),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn subscribers_rebuild_the_engines_book_from_the_feed_alone(
        commands in prop::collection::vec(command(), 1..200),
        join_at in 0usize..200,
    ) {
        let mut engine = Engine::default();
        let mut feed = Feed::new("ALPHA", SYMBOLS.map(String::from));
        let mut mirrors: Vec<Mirror> = SYMBOLS.iter().map(|s| Mirror::new(*s)).collect();
        let mut expected_symbol_seq: HashMap<String, u64> = HashMap::new();
        let mut expected_feed_seq = 0;

        for (n, command) in commands.into_iter().enumerate() {
            if n == join_at {
                for mirror in &mut mirrors {
                    let snapshot = snapshot_message(&feed, mirror.symbol());
                    let applied = mirror.apply(&snapshot);
                    let is_snapshot = matches!(applied, Applied::Snapshot { .. });
                    prop_assert!(is_snapshot);
                }
            }
            for event in engine.apply(command) {
                let Some(public) = PublicEvent::from_event(&event) else { continue };
                let bytes = feed.publish(&public, 0).encode_to_vec();
                for name in PARTICIPANTS {
                    prop_assert!(
                        !bytes.windows(name.len()).any(|w| w == name.as_bytes()),
                        "{name} leaked onto the feed"
                    );
                }
                let message = FeedMessage::decode(bytes.as_slice()).unwrap();

                let (symbol, feed_seq, symbol_seq) = sequence_numbers(&message);
                expected_feed_seq += 1;
                let expected = expected_symbol_seq.entry(symbol).or_default();
                *expected += 1;
                prop_assert_eq!(feed_seq, expected_feed_seq);
                prop_assert_eq!(symbol_seq, *expected);

                for mirror in &mut mirrors {
                    let applied = mirror.apply(&message);
                    let gap = matches!(applied, Applied::Gap { .. });
                    prop_assert!(!gap, "{:?}", applied);
                }
            }
        }

        // Anyone who had not joined yet joins now, at the end.
        for mirror in &mut mirrors {
            if mirror.symbol_seq().is_none() {
                mirror.apply(&snapshot_message(&feed, mirror.symbol()));
            }
        }

        for mirror in &mirrors {
            let book = engine.book(mirror.symbol());
            for (side, wire) in [(Side::Buy, proto::Side::Buy), (Side::Sell, proto::Side::Sell)] {
                let engine_levels: Vec<(i64, i64, i32)> = book
                    .map(|b| {
                        b.depth(side)
                            .take(md_publisher::feed::MAX_DEPTH)
                            .map(|l| (l.price.0, l.qty.0, l.order_count as i32))
                            .collect()
                    })
                    .unwrap_or_default();
                let mirrored: Vec<(i64, i64, i32)> = mirror
                    .levels(wire)
                    .into_iter()
                    .map(|(price, level)| (price, level.qty, level.order_count))
                    .collect();
                prop_assert_eq!(mirrored, engine_levels, "{} {:?}", mirror.symbol(), side);
            }
        }
    }

    /// A feed restored from its numbering and the engine's book is the feed that kept
    /// running: the same snapshots now, and the same messages from then on.
    #[test]
    fn a_restored_feed_carries_on_as_if_it_never_stopped(
        before in prop::collection::vec(command(), 0..200),
        after in prop::collection::vec(command(), 0..100),
    ) {
        let mut engine = Engine::default();
        let mut running = Feed::new("ALPHA", SYMBOLS.map(String::from));
        for command in before {
            for event in engine.apply(command) {
                if let Some(public) = PublicEvent::from_event(&event) {
                    running.publish(&public, 0);
                }
            }
        }

        let mut restored = Feed::restore(
            "ALPHA",
            SYMBOLS.map(String::from),
            running.sequence().clone(),
            &engine.snapshot(),
        );
        prop_assert_eq!(restored.sequence(), running.sequence());
        for symbol in SYMBOLS {
            prop_assert_eq!(snapshot_message(&restored, symbol), snapshot_message(&running, symbol));
        }

        for command in after {
            for event in engine.apply(command) {
                if let Some(public) = PublicEvent::from_event(&event) {
                    prop_assert_eq!(restored.publish(&public, 0), running.publish(&public, 0));
                }
            }
        }
        for symbol in SYMBOLS {
            prop_assert_eq!(snapshot_message(&restored, symbol), snapshot_message(&running, symbol));
        }
    }
}
