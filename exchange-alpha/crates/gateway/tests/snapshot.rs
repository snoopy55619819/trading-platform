//! The snapshot done-test: recovering from a snapshot plus the journal written since gives
//! exactly the state a full replay of every journal gives. Engine, order tracker and feed,
//! byte for byte, over random order flow that includes the close of a day.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use gateway::listings::Listings;
use gateway::recovery::{ExchangeState, Recovered, recover};
use matching_engine::*;
use md_publisher::PublicEvent;
use md_publisher::feed::MAX_DEPTH;
use proptest::prelude::*;

const PARTICIPANTS: [&str; 3] = ["SIM/MM-1", "SIM/TAKER", "BROKER/ACCT-1"];

fn command() -> impl Strategy<Value = Command> {
    let new_order = (
        prop::sample::select(PARTICIPANTS.to_vec()),
        prop::sample::select(vec!["ACME", "BLTZ"]),
        any::<bool>(),
        prop_oneof![
            5 => (9_990i64..=10_010).prop_map(|c| OrderType::Limit { price: PriceCents(c) }),
            1 => Just(OrderType::Market),
        ],
        prop::sample::select(vec![
            TimeInForce::Day,
            TimeInForce::Gtc,
            TimeInForce::Ioc,
            TimeInForce::Fok,
        ]),
        1i64..60,
        any::<u32>(),
    )
        .prop_map(
            |(participant, symbol, buy, order_type, time_in_force, qty, id)| {
                Command::New(NewOrder {
                    client_order_id: format!("c{id}"),
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
        (prop::sample::select(PARTICIPANTS.to_vec()), 1u64..120).prop_map(|(participant, id)| {
            Command::Cancel(CancelOrder {
                participant: participant.into(),
                order_id: OrderId(id),
            })
        });
    let close = Just(Command::EndOfDay(EndOfDay {
        business_date: "2026-11-12".into(),
    }));
    prop_oneof![40 => new_order, 10 => cancel, 1 => close]
}

fn temp_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("gw-snapshot-{}-{n}.journal", std::process::id()))
}

/// What the live gateway does with each command, minus the sockets.
fn run(exchange: &mut Recovered, commands: &[Command], listings: &Listings) {
    for command in commands {
        for event in exchange.engine.submit(command.clone()).unwrap() {
            exchange.orders.apply(&event, listings);
            if let Some(public) = PublicEvent::from_event(&event) {
                exchange.feed.publish(&public, 0);
            }
        }
    }
}

fn state(exchange: &Recovered) -> ExchangeState {
    ExchangeState::capture(&exchange.engine, &exchange.orders, exchange.feed.sequence())
}

/// The state as bytes, plus what the feed would send a new subscriber for every symbol.
fn fingerprint(exchange: &Recovered, listings: &Listings) -> (Vec<u8>, Vec<String>) {
    let bytes = serde_json::to_vec(&state(exchange)).unwrap();
    let mut books: Vec<String> = listings
        .tickers()
        .map(|symbol| format!("{:?}", exchange.feed.snapshot(&symbol, MAX_DEPTH, 0)))
        .collect();
    books.sort();
    (bytes, books)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn a_snapshot_plus_the_next_journal_equals_replaying_every_journal(
        day1 in prop::collection::vec(command(), 0..200),
        day2 in prop::collection::vec(command(), 0..200),
    ) {
        let listings = Listings::published();
        let (first, second, whole) = (temp_path(), temp_path(), temp_path());

        // Day one, then a snapshot, then day two in a journal of its own.
        let mut live = recover(&listings, &first, None).unwrap();
        run(&mut live, &day1, &listings);
        let snapshot = state(&live);
        let mut live = recover(&listings, &second, Some(snapshot.clone())).unwrap();
        run(&mut live, &day2, &listings);

        // The same two days as one journal: what a full replay would read.
        let mut joined = std::fs::read(&first).unwrap();
        joined.extend(std::fs::read(&second).unwrap());
        std::fs::write(&whole, joined).unwrap();

        let from_snapshot = recover(&listings, &second, Some(snapshot)).unwrap();
        let from_everything = recover(&listings, &whole, None).unwrap();
        for path in [first, second, whole] {
            let _ = std::fs::remove_file(path);
        }

        let expected = fingerprint(&from_everything, &listings);
        prop_assert_eq!(&fingerprint(&from_snapshot, &listings), &expected);
        prop_assert_eq!(&fingerprint(&live, &listings), &expected);
    }
}

#[test]
fn a_snapshot_survives_being_written_and_read_back() {
    let listings = Listings::published();
    let path = temp_path();
    let mut exchange = recover(&listings, &path, None).unwrap();
    let rest = |who: &str, tif| {
        Command::New(NewOrder {
            client_order_id: format!("{who}-1"),
            participant: who.into(),
            symbol: "ACME".into(),
            side: Side::Sell,
            order_type: OrderType::Limit {
                price: PriceCents(10_000),
            },
            time_in_force: tif,
            qty: Qty(100),
        })
    };
    run(
        &mut exchange,
        &[
            rest("SIM/MM-1", TimeInForce::Gtc),
            rest("BROKER/ACCT-1", TimeInForce::Day),
        ],
        &listings,
    );
    let _ = std::fs::remove_file(path);

    let snapshot = state(&exchange);
    let json = serde_json::to_string(&snapshot).unwrap();
    let read_back: ExchangeState = serde_json::from_str(&json).unwrap();

    assert_eq!(read_back, snapshot);
    assert_eq!(read_back.journal_seq, 2);
    assert_eq!(read_back.orders.orders.len(), 2);
    assert_eq!(read_back.feed.feed_seq, 2);
}
