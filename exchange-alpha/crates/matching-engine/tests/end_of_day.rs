//! The close of a business day: resting day orders expire, everything else stays.

mod common;

use Side::{Buy, Sell};
use common::{Market, cancel_reason};
use matching_engine::*;

fn expired(events: &[Event]) -> Vec<(u64, &str, i64)> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Canceled {
                order_id,
                participant,
                remaining,
                reason: CancelReason::Expired,
                ..
            } => Some((order_id.0, participant.as_str(), remaining.0)),
            _ => None,
        })
        .collect()
}

#[test]
fn day_orders_expire_and_good_till_cancelled_orders_stay() {
    let mut m = Market::default();
    m.limit_tif("alice", Sell, 100, 4210, TimeInForce::Day); // order 1
    m.limit_tif("bob", Sell, 50, 4210, TimeInForce::Gtc); // order 2
    m.limit_tif("carol", Buy, 70, 4200, TimeInForce::Day); // order 3

    let events = m.end_of_day();

    assert_eq!(expired(&events), vec![(3, "carol", 70), (1, "alice", 100)]);
    assert_eq!(m.levels(Sell), vec![(4210, 50)]);
    assert!(m.levels(Buy).is_empty());
}

#[test]
fn a_partly_filled_day_order_expires_with_what_is_left() {
    let mut m = Market::default();
    m.limit_tif("alice", Sell, 100, 4210, TimeInForce::Day); // order 1
    m.limit("bob", Buy, 30, 4210);

    assert_eq!(expired(&m.end_of_day()), vec![(1, "alice", 70)]);
}

#[test]
fn the_close_publishes_each_changed_level_once() {
    let mut m = Market::default();
    m.limit_tif("alice", Sell, 100, 4210, TimeInForce::Day);
    m.limit_tif("bob", Sell, 50, 4210, TimeInForce::Day);
    m.limit_tif("carol", Sell, 40, 4211, TimeInForce::Gtc);

    let deltas: Vec<_> = m
        .end_of_day()
        .into_iter()
        .filter_map(|event| match event {
            Event::BookDelta(delta) => Some(delta),
            _ => None,
        })
        .collect();

    assert_eq!(
        deltas,
        vec![BookDelta {
            symbol: "ACME".into(),
            side: Sell,
            price: PriceCents(4210),
            qty: Qty::ZERO,
            order_count: 0,
        }]
    );
}

#[test]
fn the_close_ends_with_day_closed_after_every_expiry() {
    let mut m = Market::default();
    m.limit_tif("alice", Sell, 100, 4210, TimeInForce::Day);

    let events = m.end_of_day();

    assert_eq!(
        events.last(),
        Some(&Event::DayClosed {
            business_date: "2026-11-12".into()
        })
    );
    assert_eq!(expired(&events).len(), 1);
}

#[test]
fn an_expired_order_can_no_longer_be_cancelled() {
    let mut m = Market::default();
    m.limit_tif("alice", Sell, 100, 4210, TimeInForce::Day); // order 1
    m.end_of_day();

    let events = m.cancel("alice", 1);

    assert_eq!(cancel_reason(&events), None);
    assert!(matches!(
        events.as_slice(),
        [Event::CancelRejected {
            reason: RejectReason::UnknownOrder,
            ..
        }]
    ));
}

#[test]
fn a_close_with_no_day_orders_changes_nothing() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210);
    let before = m.engine.snapshot();

    assert_eq!(
        m.end_of_day(),
        vec![Event::DayClosed {
            business_date: "2026-11-12".into()
        }]
    );
    assert_eq!(m.engine.snapshot(), before);
}

#[test]
fn ids_carry_on_across_the_close() {
    let mut m = Market::default();
    m.limit_tif("alice", Sell, 100, 4210, TimeInForce::Day); // order 1
    m.end_of_day();

    let events = m.limit("bob", Sell, 100, 4210);

    assert!(events.iter().any(|event| matches!(
        event,
        Event::Accepted {
            order_id: OrderId(2),
            ..
        }
    )));
}

#[test]
fn the_close_is_journaled_as_end_of_day() {
    let command = Command::EndOfDay(EndOfDay {
        business_date: "2026-11-12".into(),
    });
    let json = serde_json::to_string(&command).unwrap();

    assert_eq!(
        json,
        r#"{"type":"END_OF_DAY","business_date":"2026-11-12"}"#
    );
    assert_eq!(serde_json::from_str::<Command>(&json).unwrap(), command);
}
