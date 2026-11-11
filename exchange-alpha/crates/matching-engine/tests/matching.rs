//! Matching behaviour, one rule per test.

mod common;

use Side::{Buy, Sell};
use common::{Market, cancel_reason, fills, trades};
use matching_engine::*;

#[test]
fn an_order_that_does_not_cross_rests() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210);
    let events = m.limit("bob", Buy, 100, 4200);

    assert!(trades(&events).is_empty());
    assert_eq!(m.levels(Sell), vec![(4210, 100)]);
    assert_eq!(m.levels(Buy), vec![(4200, 100)]);
    assert_eq!(m.book().spread(), Some(PriceCents(10)));
}

#[test]
fn the_best_price_trades_first() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4215);
    m.limit("bob", Sell, 100, 4210); // cheaper, though it arrived later
    let events = m.limit("carol", Buy, 100, 4215);

    assert_eq!(fills(&events), vec![("bob", 4210, 100)]);
}

#[test]
fn at_the_same_price_the_earlier_order_trades_first() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210);
    m.limit("bob", Sell, 100, 4210);
    let events = m.limit("carol", Buy, 150, 4210);

    assert_eq!(
        fills(&events),
        vec![("alice", 4210, 100), ("bob", 4210, 50)]
    );
}

#[test]
fn bids_are_matched_highest_first() {
    let mut m = Market::default();
    m.limit("alice", Buy, 100, 4195);
    m.limit("bob", Buy, 100, 4205);
    let events = m.limit("carol", Sell, 150, 4190);

    let buyers: Vec<_> = trades(&events).iter().map(|t| t.buyer().0).collect();
    assert_eq!(buyers, vec!["bob", "alice"]);
}

#[test]
fn an_aggressive_order_walks_the_book_one_trade_per_resting_order() {
    let mut m = Market::default();
    m.limit("alice", Sell, 50, 4210);
    m.limit("bob", Sell, 50, 4211);
    m.limit("carol", Sell, 50, 4212);
    let events = m.limit("dave", Buy, 120, 4212);

    assert_eq!(
        fills(&events),
        vec![("alice", 4210, 50), ("bob", 4211, 50), ("carol", 4212, 20)]
    );
    assert_eq!(m.levels(Sell), vec![(4212, 30)]);
}

#[test]
fn trades_happen_at_the_resting_orders_price() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210);
    let events = m.limit("bob", Buy, 100, 4250); // willing to pay more

    assert_eq!(trades(&events)[0].price, PriceCents(4210));
}

#[test]
fn an_unfilled_remainder_rests_at_its_limit() {
    let mut m = Market::default();
    m.limit("alice", Sell, 30, 4210);
    m.limit("bob", Buy, 100, 4210);

    assert!(m.levels(Sell).is_empty());
    assert_eq!(m.levels(Buy), vec![(4210, 70)]);
}

#[test]
fn a_partially_filled_resting_order_keeps_its_place_in_the_queue() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210);
    m.limit("bob", Sell, 100, 4210);
    m.limit("carol", Buy, 30, 4210); // alice now has 70 left, still first in line
    let events = m.limit("dave", Buy, 80, 4210);

    assert_eq!(fills(&events), vec![("alice", 4210, 70), ("bob", 4210, 10)]);
}

#[test]
fn a_market_order_takes_any_price_and_cancels_what_it_cannot_fill() {
    let mut m = Market::default();
    m.limit("alice", Sell, 50, 4210);
    m.limit("bob", Sell, 50, 9900);
    let events = m.market("carol", Buy, 150);

    assert_eq!(fills(&events), vec![("alice", 4210, 50), ("bob", 9900, 50)]);
    assert_eq!(
        cancel_reason(&events),
        Some((CancelReason::NoLiquidity, 50))
    );
    assert!(m.book().is_empty(), "a market order never rests");
}

#[test]
fn a_market_order_into_an_empty_book_cancels_everything() {
    let mut m = Market::default();
    let events = m.market("alice", Sell, 100);

    assert!(trades(&events).is_empty());
    assert_eq!(
        cancel_reason(&events),
        Some((CancelReason::NoLiquidity, 100))
    );
}

#[test]
fn ioc_trades_what_it_can_and_never_rests() {
    let mut m = Market::default();
    m.limit("alice", Sell, 30, 4210);
    let events = m.limit_tif("bob", Buy, 100, 4210, TimeInForce::Ioc);

    assert_eq!(fills(&events), vec![("alice", 4210, 30)]);
    assert_eq!(
        cancel_reason(&events),
        Some((CancelReason::ImmediateOrCancel, 70))
    );
    assert!(m.book().is_empty());
}

#[test]
fn fok_that_cannot_fill_completely_trades_nothing() {
    let mut m = Market::default();
    m.limit("alice", Sell, 60, 4210);
    m.limit("bob", Sell, 30, 4211);
    let events = m.limit_tif("carol", Buy, 100, 4211, TimeInForce::Fok);

    assert!(trades(&events).is_empty());
    assert_eq!(
        cancel_reason(&events),
        Some((CancelReason::FillOrKill, 100))
    );
    assert_eq!(
        m.levels(Sell),
        vec![(4210, 60), (4211, 30)],
        "book untouched"
    );
}

#[test]
fn fok_that_can_fill_completely_does() {
    let mut m = Market::default();
    m.limit("alice", Sell, 60, 4210);
    m.limit("bob", Sell, 40, 4211);
    let events = m.limit_tif("carol", Buy, 100, 4211, TimeInForce::Fok);

    assert_eq!(fills(&events), vec![("alice", 4210, 60), ("bob", 4211, 40)]);
    assert_eq!(cancel_reason(&events), None);
}

#[test]
fn fok_does_not_count_liquidity_beyond_its_limit() {
    let mut m = Market::default();
    m.limit("alice", Sell, 60, 4210);
    m.limit("bob", Sell, 100, 4220);
    let events = m.limit_tif("carol", Buy, 100, 4215, TimeInForce::Fok);

    assert!(trades(&events).is_empty());
}

#[test]
fn self_trade_prevention_cancels_the_incoming_order_and_keeps_the_resting_one() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210);
    let events = m.limit("alice", Buy, 50, 4210);

    assert!(trades(&events).is_empty());
    assert_eq!(
        cancel_reason(&events),
        Some((CancelReason::SelfTradePrevention, 50))
    );
    assert_eq!(m.levels(Sell), vec![(4210, 100)]);
    assert!(m.levels(Buy).is_empty(), "the incoming order must not rest");
}

#[test]
fn self_trade_prevention_still_lets_earlier_counterparties_fill() {
    let mut m = Market::default();
    m.limit("bob", Sell, 40, 4210);
    m.limit("alice", Sell, 100, 4210);
    let events = m.limit("alice", Buy, 100, 4210);

    assert_eq!(fills(&events), vec![("bob", 4210, 40)]);
    assert_eq!(
        cancel_reason(&events),
        Some((CancelReason::SelfTradePrevention, 60))
    );
}

#[test]
fn fok_counts_only_liquidity_ahead_of_the_takers_own_order() {
    let mut m = Market::default();
    m.limit("bob", Sell, 40, 4210);
    m.limit("alice", Sell, 100, 4210);
    m.limit("carol", Sell, 100, 4210); // behind alice's own order, so unreachable
    let events = m.limit_tif("alice", Buy, 100, 4210, TimeInForce::Fok);

    assert!(trades(&events).is_empty());
    assert_eq!(
        cancel_reason(&events),
        Some((CancelReason::FillOrKill, 100))
    );
}

#[test]
fn cancelling_removes_the_order_and_an_emptied_level() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210); // order 1
    m.limit("bob", Sell, 100, 4211); // order 2
    let events = m.cancel("alice", 1);

    assert_eq!(cancel_reason(&events), Some((CancelReason::Requested, 100)));
    assert_eq!(m.levels(Sell), vec![(4211, 100)]);
    assert!(events.contains(&Event::BookDelta(BookDelta {
        symbol: "ACME".into(),
        side: Sell,
        price: PriceCents(4210),
        qty: Qty::ZERO,
        order_count: 0,
    })));
}

#[test]
fn cancelling_from_the_middle_of_a_queue_keeps_the_others_in_order() {
    let mut m = Market::default();
    m.limit("alice", Sell, 10, 4210); // 1
    m.limit("bob", Sell, 10, 4210); // 2
    m.limit("carol", Sell, 10, 4210); // 3
    m.cancel("bob", 2);
    let events = m.limit("dave", Buy, 20, 4210);

    assert_eq!(
        fills(&events),
        vec![("alice", 4210, 10), ("carol", 4210, 10)]
    );
}

#[test]
fn only_the_owner_can_cancel_and_strangers_learn_nothing() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210); // order 1

    let not_yours = m.cancel("mallory", 1);
    let does_not_exist = m.cancel("mallory", 999);

    let reason = |events: &[Event]| match &events[0] {
        Event::CancelRejected { reason, .. } => *reason,
        other => panic!("expected CancelRejected, got {other:?}"),
    };
    assert_eq!(reason(&not_yours), RejectReason::UnknownOrder);
    assert_eq!(reason(&does_not_exist), reason(&not_yours));
    assert_eq!(m.levels(Sell), vec![(4210, 100)], "order untouched");
}

#[test]
fn a_filled_order_can_no_longer_be_cancelled() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210); // order 1
    m.limit("bob", Buy, 100, 4210);
    let events = m.cancel("alice", 1);

    assert!(matches!(events[0], Event::CancelRejected { .. }));
}

#[test]
fn invalid_orders_are_rejected_without_using_an_order_id() {
    let mut m = Market::default();
    let zero = m.limit("alice", Buy, 0, 4210);
    let negative = m.limit("alice", Buy, -5, 4210);
    let free = m.limit("alice", Buy, 10, 0);
    let accepted = m.limit("alice", Buy, 10, 4210);

    let reason = |events: &[Event]| match &events[0] {
        Event::Rejected { reason, .. } => *reason,
        other => panic!("expected Rejected, got {other:?}"),
    };
    assert_eq!(reason(&zero), RejectReason::InvalidQuantity);
    assert_eq!(reason(&negative), RejectReason::InvalidQuantity);
    assert_eq!(reason(&free), RejectReason::InvalidPrice);
    assert!(
        matches!(
            accepted[0],
            Event::Accepted {
                order_id: OrderId(1),
                ..
            }
        ),
        "rejections must not consume ids"
    );
}

#[test]
fn events_come_out_in_a_fixed_order() {
    let mut m = Market::default();
    m.limit("alice", Sell, 30, 4210);
    m.limit("bob", Sell, 30, 4211);
    let events = m.limit_tif("carol", Buy, 100, 4211, TimeInForce::Ioc);

    let kinds: Vec<&str> = events
        .iter()
        .map(|event| match event {
            Event::Accepted { .. } => "accepted",
            Event::Trade(_) => "trade",
            Event::Canceled { .. } => "canceled",
            Event::BookDelta(_) => "delta",
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(
        kinds,
        vec!["accepted", "trade", "trade", "canceled", "delta", "delta"]
    );
}

#[test]
fn book_deltas_carry_the_levels_new_total_not_a_difference() {
    let mut m = Market::default();
    m.limit("alice", Sell, 100, 4210);
    m.limit("bob", Sell, 50, 4210);
    let events = m.limit("carol", Buy, 30, 4210);

    let deltas: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Event::BookDelta(delta) => Some((delta.price.0, delta.qty.0, delta.order_count)),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, vec![(4210, 120, 2)]);
}

#[test]
fn symbols_have_independent_books() {
    let mut engine = Engine::default();
    let order = |symbol: &str, who: &str, side| {
        Command::New(NewOrder {
            client_order_id: "c".into(),
            participant: who.into(),
            symbol: symbol.into(),
            side,
            order_type: OrderType::Limit {
                price: PriceCents(4210),
            },
            time_in_force: TimeInForce::Gtc,
            qty: Qty(100),
        })
    };
    engine.apply(order("ACME", "alice", Sell));
    let events = engine.apply(order("BLTZ", "bob", Buy));

    assert!(
        trades(&events).is_empty(),
        "a BLTZ bid must not hit an ACME offer"
    );
    assert_eq!(engine.resting_order_count(), 2);
}
