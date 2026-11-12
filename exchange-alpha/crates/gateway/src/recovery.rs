//! Rebuilding the exchange's state on start, and capturing it for a snapshot.
//!
//! The state is three things derived from the journal: the engine's books, the order
//! tracker (what execution reports need) and the market data feed's numbering. On start they
//! come either from replaying the whole journal, or from a snapshot plus the journal written
//! since. Both paths go through [`recover`], and the tests hold them to the same result.

use std::path::Path;

use anyhow::{Context, Result, anyhow};
use matching_engine::{Engine, Event, JournaledEngine};
use md_publisher::{Feed, PublicEvent, Sequence};
use serde::{Deserialize, Serialize};

use crate::listings::Listings;
use crate::orders::{OrderTracker, OrdersState};

/// Everything a start needs besides the journal written after it. Taken between commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExchangeState {
    /// The last journal entry this state includes. The next journal starts at one more.
    pub journal_seq: u64,
    pub engine: matching_engine::Snapshot,
    pub orders: OrdersState,
    /// The feed's numbering. Its levels are the engine's, so they are not stored twice.
    pub feed: Sequence,
}

impl ExchangeState {
    /// The state of an exchange that has never done anything.
    pub fn empty() -> Self {
        ExchangeState {
            journal_seq: 0,
            engine: Engine::default().snapshot(),
            orders: OrdersState {
                orders: Vec::new(),
                used_client_ids: Vec::new(),
                finished: Vec::new(),
            },
            feed: Sequence::default(),
        }
    }

    pub fn capture(engine: &JournaledEngine, orders: &OrderTracker, feed: &Sequence) -> Self {
        ExchangeState {
            journal_seq: engine.last_seq(),
            engine: engine.engine().snapshot(),
            orders: orders.state(),
            feed: feed.clone(),
        }
    }
}

/// The exchange as it was: ready to take the next command.
pub struct Recovered {
    pub engine: JournaledEngine,
    pub orders: OrderTracker,
    pub feed: Feed,
    /// The journal's last command closed the business day: the exchange stopped part way
    /// through a roll, after the close but before the next day's snapshot.
    pub ended_with_close: bool,
}

/// Opens `journal` and replays it, starting from `from` if given or from nothing if not.
pub fn recover(
    listings: &Listings,
    journal: &Path,
    from: Option<ExchangeState>,
) -> Result<Recovered> {
    let venue = listings.venue.clone();
    let (engine, mut orders, mut feed, after_seq) = match from {
        None => (
            Engine::default(),
            OrderTracker::new(listings),
            Feed::new(venue, listings.tickers()),
            0,
        ),
        Some(state) => {
            let feed = Feed::restore(venue, listings.tickers(), state.feed, &state.engine);
            let engine = Engine::restore(state.engine)
                .map_err(|why| anyhow!("the snapshot is not consistent: {why}"))?;
            let orders = OrderTracker::restore(listings, state.orders);
            (engine, orders, feed, state.journal_seq)
        }
    };
    let mut ended_with_close = false;
    let engine = JournaledEngine::resume_observing(journal, engine, after_seq, |event| {
        // Every command produces at least one event, and a close always ends with this one.
        ended_with_close = matches!(event, Event::DayClosed { .. });
        orders.apply(event, listings);
        if let Some(public) = PublicEvent::from_event(event) {
            feed.publish(&public, 0); // not sent anywhere: only the state is wanted
        }
    })
    .with_context(|| format!("opening journal {}", journal.display()))?;
    Ok(Recovered {
        engine,
        orders,
        feed,
        ended_with_close,
    })
}
