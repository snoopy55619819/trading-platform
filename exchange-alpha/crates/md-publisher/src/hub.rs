//! Fan-out: who is subscribed to what, and what happens to a subscriber that cannot keep up.
//!
//! **Slow-subscriber policy: buffer up to [`SUBSCRIBER_BUFFER`] messages, then disconnect.**
//! The hub never waits for a subscriber. Each one has a bounded queue; if a message will not
//! fit, that subscriber is dropped and everyone else carries on. A dropped subscriber
//! reconnects and starts again from a snapshot, which costs it one round trip. The
//! alternatives are worse: waiting would let one slow reader stall the feed for everyone
//! (and, through the feed, the engine), and silently skipping messages would hand it a book
//! that is quietly wrong. Disconnecting is loud, and recovery is already built.
//!
//! Pure like the feed: no sockets, no clock. The server feeds it and drains the queues.

use std::collections::{BTreeSet, HashMap};

use bytes::Bytes;
use prost::Message;
use tokio::sync::mpsc::{self, error::TrySendError};
use tracing::{info, warn};

use crate::feed::{DEFAULT_DEPTH, Feed};
use crate::proto::{ClientMessage, FeedMessage, client_message, feed_message};
use crate::public::PublicEvent;

/// Messages a subscriber may fall behind by before it is disconnected. At the pace of the
/// simulated market this is many seconds of slack; a subscriber that uses it all is not
/// coming back.
pub const SUBSCRIBER_BUFFER: usize = 4096;

pub type SubscriberId = u64;

struct Subscriber {
    /// Encoded `FeedMessage`s. Dropping the sender is how the hub disconnects someone.
    outbox: mpsc::Sender<Bytes>,
    symbols: BTreeSet<String>,
    depth: usize,
}

pub struct Hub {
    feed: Feed,
    subscribers: HashMap<SubscriberId, Subscriber>,
}

impl Hub {
    pub fn new(feed: Feed) -> Hub {
        Hub {
            feed,
            subscribers: HashMap::new(),
        }
    }

    pub fn feed(&self) -> &Feed {
        &self.feed
    }

    pub fn subscriber_count(&self) -> usize {
        self.subscribers.len()
    }

    pub fn connect(&mut self, id: SubscriberId, outbox: mpsc::Sender<Bytes>) {
        let subscriber = Subscriber {
            outbox,
            symbols: BTreeSet::new(),
            depth: DEFAULT_DEPTH,
        };
        self.subscribers.insert(id, subscriber);
    }

    pub fn disconnect(&mut self, id: SubscriberId) {
        self.subscribers.remove(&id);
    }

    /// Sequences a batch of events (everything one command did) and sends each message to
    /// the subscribers of its symbol. Every message is encoded once, however many receive it.
    pub fn publish(&mut self, events: &[PublicEvent], ts_ns: i64) {
        for event in events {
            let message = self.feed.publish(event, ts_ns);
            let bytes = Bytes::from(message.encode_to_vec());
            let receivers: Vec<SubscriberId> = self
                .subscribers
                .iter()
                .filter(|(_, s)| s.symbols.contains(event.symbol()))
                .map(|(id, _)| *id)
                .collect();
            for id in receivers {
                self.deliver(id, bytes.clone());
            }
        }
    }

    /// Sends a heartbeat to every connection, subscribed to anything or not.
    pub fn heartbeat(&mut self, ts_ns: i64) {
        let bytes = Bytes::from(self.feed.heartbeat(ts_ns).encode_to_vec());
        let everyone: Vec<SubscriberId> = self.subscribers.keys().copied().collect();
        for id in everyone {
            self.deliver(id, bytes.clone());
        }
    }

    pub fn on_client(&mut self, id: SubscriberId, message: ClientMessage, ts_ns: i64) {
        let Some(subscriber) = self.subscribers.get_mut(&id) else {
            return;
        };
        match message.payload {
            Some(client_message::Payload::Subscribe(subscribe)) => {
                if subscribe.depth_limit > 0 {
                    subscriber.depth = subscribe.depth_limit as usize;
                }
                let listed: Vec<String> = subscribe
                    .symbols
                    .into_iter()
                    .filter(|symbol| self.feed.is_listed(symbol))
                    .collect();
                subscriber.symbols.extend(listed.iter().cloned());
                info!(subscriber = id, symbols = ?listed, "subscribed");
                for symbol in listed {
                    self.send_snapshot(id, &symbol, ts_ns);
                }
            }
            Some(client_message::Payload::Unsubscribe(unsubscribe)) => {
                for symbol in &unsubscribe.symbols {
                    subscriber.symbols.remove(symbol);
                }
            }
            Some(client_message::Payload::Resync(resync)) => {
                // The answer is always a fresh snapshot. The recent buffer only helps a human
                // work out why the subscriber lost track.
                warn!(
                    subscriber = id,
                    symbols = ?resync.symbols,
                    last_good_feed_seq = resync.last_good_feed_seq,
                    recent = ?self.feed.recent_range(),
                    "resync requested"
                );
                let symbols: Vec<String> = resync
                    .symbols
                    .into_iter()
                    .filter(|symbol| subscriber.symbols.contains(symbol))
                    .collect();
                for symbol in symbols {
                    self.send_snapshot(id, &symbol, ts_ns);
                }
            }
            None => {}
        }
    }

    fn send_snapshot(&mut self, id: SubscriberId, symbol: &str, ts_ns: i64) {
        let Some(depth) = self.subscribers.get(&id).map(|s| s.depth) else {
            return;
        };
        if let Some(snapshot) = self.feed.snapshot(symbol, depth, ts_ns) {
            let message = FeedMessage {
                payload: Some(feed_message::Payload::Snapshot(snapshot)),
            };
            self.deliver(id, Bytes::from(message.encode_to_vec()));
        }
    }

    /// Queues `bytes` for one subscriber, or drops the subscriber if its queue is full.
    fn deliver(&mut self, id: SubscriberId, bytes: Bytes) {
        let Some(subscriber) = self.subscribers.get(&id) else {
            return;
        };
        match subscriber.outbox.try_send(bytes) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                warn!(
                    subscriber = id,
                    buffer = SUBSCRIBER_BUFFER,
                    "subscriber fell too far behind; disconnecting"
                );
                self.subscribers.remove(&id);
            }
            Err(TrySendError::Closed(_)) => {
                self.subscribers.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use matching_engine::{PriceCents, Qty, Side};

    use super::*;
    use crate::proto::{ResyncRequest, Subscribe, Unsubscribe};

    fn hub() -> Hub {
        Hub::new(Feed::new("ALPHA", ["ACME".to_string(), "BLTZ".to_string()]))
    }

    fn level(symbol: &str, price: i64) -> PublicEvent {
        PublicEvent::Level {
            symbol: symbol.into(),
            side: Side::Buy,
            price: PriceCents(price),
            qty: Qty(100),
            order_count: 1,
        }
    }

    fn subscribe(symbols: &[&str]) -> ClientMessage {
        ClientMessage {
            payload: Some(client_message::Payload::Subscribe(Subscribe {
                symbols: symbols.iter().map(|s| s.to_string()).collect(),
                depth_limit: 0,
            })),
        }
    }

    fn drain(rx: &mut mpsc::Receiver<Bytes>) -> Vec<FeedMessage> {
        let mut messages = Vec::new();
        while let Ok(bytes) = rx.try_recv() {
            messages.push(FeedMessage::decode(bytes).unwrap());
        }
        messages
    }

    fn kinds(messages: &[FeedMessage]) -> Vec<&'static str> {
        messages
            .iter()
            .map(|m| match m.payload {
                Some(feed_message::Payload::Snapshot(_)) => "snapshot",
                Some(feed_message::Payload::BookDelta(_)) => "delta",
                Some(feed_message::Payload::TradePrint(_)) => "trade",
                Some(feed_message::Payload::Heartbeat(_)) => "heartbeat",
                None => "empty",
            })
            .collect()
    }

    #[test]
    fn subscribers_get_a_snapshot_then_only_their_symbols() {
        let mut hub = hub();
        let (tx, mut rx) = mpsc::channel(16);
        hub.connect(1, tx);
        hub.on_client(1, subscribe(&["ACME", "NOPE"]), 0);
        hub.publish(&[level("ACME", 4200), level("BLTZ", 1800)], 0);
        hub.heartbeat(0);
        assert_eq!(kinds(&drain(&mut rx)), ["snapshot", "delta", "heartbeat"]);

        let unsubscribe = ClientMessage {
            payload: Some(client_message::Payload::Unsubscribe(Unsubscribe {
                symbols: vec!["ACME".into()],
            })),
        };
        hub.on_client(1, unsubscribe, 0);
        hub.publish(&[level("ACME", 4201)], 0);
        assert!(drain(&mut rx).is_empty());
    }

    #[test]
    fn a_resync_is_answered_with_a_snapshot_for_subscribed_symbols_only() {
        let mut hub = hub();
        let (tx, mut rx) = mpsc::channel(16);
        hub.connect(1, tx);
        hub.on_client(1, subscribe(&["ACME"]), 0);
        hub.publish(&[level("ACME", 4200), level("ACME", 4201)], 0);
        drain(&mut rx);

        let resync = ClientMessage {
            payload: Some(client_message::Payload::Resync(ResyncRequest {
                symbols: vec!["ACME".into(), "BLTZ".into()],
                last_good_feed_seq: 1,
            })),
        };
        hub.on_client(1, resync, 0);
        let messages = drain(&mut rx);
        let Some(feed_message::Payload::Snapshot(snapshot)) = &messages[0].payload else {
            panic!("expected a snapshot, got {messages:?}");
        };
        assert_eq!(messages.len(), 1);
        assert_eq!((snapshot.symbol.as_str(), snapshot.symbol_seq), ("ACME", 2));
        assert_eq!(snapshot.bids.len(), 2);
    }

    #[test]
    fn a_subscriber_that_falls_behind_is_dropped_and_nobody_else_notices() {
        let mut hub = hub();
        let (slow_tx, mut slow_rx) = mpsc::channel(4);
        let (fast_tx, mut fast_rx) = mpsc::channel(1024);
        hub.connect(1, slow_tx);
        hub.connect(2, fast_tx);
        hub.on_client(1, subscribe(&["ACME"]), 0);
        hub.on_client(2, subscribe(&["ACME"]), 0);

        // The slow one never reads. Its snapshot plus three deltas fill its queue; the
        // fourth delta does not fit.
        let events: Vec<PublicEvent> = (0..100).map(|n| level("ACME", 4000 + n)).collect();
        hub.publish(&events, 0);

        assert_eq!(hub.subscriber_count(), 1);
        assert_eq!(drain(&mut slow_rx).len(), 4);
        assert!(
            slow_rx.is_closed(),
            "the slow subscriber's queue was closed"
        );
        assert_eq!(drain(&mut fast_rx).len(), 101); // its snapshot, then every delta
    }
}
