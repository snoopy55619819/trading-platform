//! The business-day roll: day orders expire over FIX, the next day starts from a snapshot,
//! and a restart replays only the current day, whether the exchange stopped before, during or
//! after a roll.

mod common;

use std::path::Path;
use std::time::Duration;

use common::*;
use fix_core::UtcMillis;
use fix_core::tags::*;
use gateway::recovery::ExchangeState;
use gateway::{Core, MemoryStore};

const DAY_MS: u64 = 86_400_000;

fn day_limit(id: &str, side: &str, qty: &str, price: &str) -> fix_core::Message {
    let mut order = limit(id, side, qty, "ACME", price);
    order.set(TIME_IN_FORCE, "0"); // Day
    order
}

fn files(dir: &Path, suffix: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(suffix))
        .collect();
    names.sort();
    names
}

/// Opens the exchange in `dir` as if it were `now`, and returns its state.
async fn open_at(dir: &TempData, now: UtcMillis) -> ExchangeState {
    let (core, _feed) = Core::open_at(
        &dir.0,
        MemoryStore::default(),
        COMP_IDS.map(String::from),
        clock(),
        now,
    )
    .await
    .expect("open core");
    core.state()
}

#[tokio::test]
async fn at_the_roll_day_orders_expire_over_fix_and_good_till_cancelled_ones_stay() {
    let data = TempData::new();
    let gateway = start_gateway_with(&data, MemoryStore::default(), clock().every(1)).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;

    broker.send(limit("g1", "2", "100", "ACME", "42.00")).await; // good till cancelled
    assert_eq!(exec(&broker.next().await), ("0", "0"));
    broker.send(day_limit("d1", "2", "100", "42.10")).await;
    assert_eq!(exec(&broker.next().await), ("0", "0"));

    let expired = tokio::time::timeout(Duration::from_secs(5), broker.next())
        .await
        .expect("the day order expires at the next roll");
    assert_eq!(exec(&expired), ("C", "C")); // Expired, Expired
    assert_eq!(expired.get(CL_ORD_ID), Some("d1"));
    assert_eq!(expired.get(LEAVES_QTY), Some("0"));
    assert_eq!(expired.get(TEXT), Some("day order expired at end of day"));

    // A ClOrdID is unique per business day: yesterday's finished order's id is free again,
    // but a resting order's is not.
    broker.send(day_limit("d1", "2", "10", "42.20")).await;
    assert_eq!(exec(&broker.next().await), ("0", "0"));
    broker.send(limit("g1", "2", "10", "ACME", "42.20")).await;
    assert_eq!(broker.next().await.get(ORD_REJ_REASON), Some("6")); // duplicate

    // Each roll wrote a snapshot and started a journal; the first day's journal ends with
    // the close.
    assert!(files(&data.0, ".snapshot.json").len() >= 2);
    let journals = files(&data.0, ".journal");
    let first = std::fs::read_to_string(data.0.join(&journals[0])).unwrap();
    assert!(first.lines().last().unwrap().contains("END_OF_DAY"));
}

#[tokio::test]
async fn closed_through_a_roll_it_closes_the_day_on_start_and_keeps_good_till_cancelled() {
    let data = TempData::new();
    let gateway = start_gateway(&data, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    broker.send(limit("g1", "2", "100", "ACME", "42.00")).await;
    broker.next().await;
    broker.send(day_limit("d1", "2", "100", "42.10")).await;
    broker.next().await;
    gateway.kill();

    // Back a day later: the day is closed before anything else happens.
    let tomorrow = UtcMillis(UtcMillis::now().0 + DAY_MS);
    let state = open_at(&data, tomorrow).await;
    let resting: Vec<&str> = state
        .engine
        .books
        .iter()
        .flat_map(|book| book.asks.iter().flat_map(|level| &level.orders))
        .map(|order| order.client_order_id.as_str())
        .collect();
    assert_eq!(resting, ["g1"]);
    assert_eq!(
        state.orders.orders.len(),
        1,
        "finished orders are forgotten"
    );
    assert_eq!(files(&data.0, ".snapshot.json").len(), 2);

    // Opening again the same day finds the new day's snapshot and nothing to redo.
    assert_eq!(open_at(&data, tomorrow).await, state);
    assert_eq!(files(&data.0, ".snapshot.json").len(), 2);
}

#[tokio::test]
async fn stopped_during_a_roll_it_finishes_the_roll_on_start() {
    let data = TempData::new();
    let gateway = start_gateway(&data, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    broker.send(limit("g1", "2", "100", "ACME", "42.00")).await;
    broker.next().await;
    broker.send(day_limit("d1", "2", "100", "42.10")).await;
    broker.next().await;
    gateway.kill();
    let tomorrow = UtcMillis(UtcMillis::now().0 + DAY_MS);
    let after_a_clean_roll = open_at(&data, tomorrow).await;

    // Now undo the second half of that roll: the close is in the old day's journal, but the
    // new day's snapshot and journal were never written. That is a crash mid-roll.
    let newest_snapshot = files(&data.0, ".snapshot.json").pop().unwrap();
    let newest_journal = files(&data.0, ".journal").pop().unwrap();
    std::fs::remove_file(data.0.join(newest_snapshot)).unwrap();
    std::fs::remove_file(data.0.join(newest_journal)).unwrap();

    assert_eq!(open_at(&data, tomorrow).await, after_a_clean_roll);
    assert_eq!(files(&data.0, ".snapshot.json").len(), 2);
}

#[tokio::test]
async fn a_journal_from_before_business_days_is_refused() {
    let data = TempData::new();
    std::fs::create_dir_all(&data.0).unwrap();
    std::fs::write(data.0.join("alpha.journal"), "").unwrap();

    let error = Core::open(
        &data.0,
        MemoryStore::default(),
        COMP_IDS.map(String::from),
        clock(),
    )
    .await
    .err()
    .expect("must refuse");
    assert!(
        error.to_string().contains("before daily snapshots"),
        "{error}"
    );
}
