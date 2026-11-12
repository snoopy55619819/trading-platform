//! Market data end to end: orders in over FIX, the feed out over WebSocket, from the same
//! running exchange.

mod common;

use std::net::SocketAddr;
use std::time::Duration;

use common::*;
use futures_util::{SinkExt, StreamExt};
use gateway::MemoryStore;
use md_publisher::proto::{
    BookDelta, ClientMessage, FeedMessage, Side, Snapshot, Subscribe, TradePrint, client_message,
    feed_message::Payload,
};
use md_publisher::{Applied, Mirror};
use prost::Message as _;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// A feed subscriber, recording every raw frame it receives.
struct Subscriber {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    raw: Vec<Vec<u8>>,
}

impl Subscriber {
    /// Connects, subscribes to `symbols` and returns the snapshot for the first of them.
    async fn subscribe(addr: SocketAddr, symbols: &[&str]) -> (Subscriber, Snapshot) {
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .unwrap();
        let mut subscriber = Subscriber {
            socket,
            raw: Vec::new(),
        };
        let subscribe = ClientMessage {
            payload: Some(client_message::Payload::Subscribe(Subscribe {
                symbols: symbols.iter().map(|s| s.to_string()).collect(),
                depth_limit: 0,
            })),
        };
        subscriber
            .socket
            .send(Message::Binary(subscribe.encode_to_vec().into()))
            .await
            .unwrap();
        let Some(Payload::Snapshot(snapshot)) = subscriber.next().await.payload else {
            panic!("the first message after subscribing was not a snapshot");
        };
        (subscriber, snapshot)
    }

    /// The next message that is not a heartbeat, within five seconds.
    async fn next(&mut self) -> FeedMessage {
        // One deadline for the whole wait: heartbeats arrive every second, so a timeout per
        // frame would never fire.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let frame = tokio::time::timeout_at(deadline, self.socket.next())
                .await
                .expect("timed out waiting for market data")
                .expect("feed closed")
                .unwrap();
            let Message::Binary(bytes) = frame else {
                continue;
            };
            self.raw.push(bytes.to_vec());
            let message = FeedMessage::decode(bytes).unwrap();
            if !matches!(message.payload, Some(Payload::Heartbeat(_))) {
                return message;
            }
        }
    }

    async fn delta(&mut self) -> BookDelta {
        match self.next().await.payload {
            Some(Payload::BookDelta(delta)) => delta,
            other => panic!("expected a BookDelta, got {other:?}"),
        }
    }

    async fn trade(&mut self) -> TradePrint {
        match self.next().await.payload {
            Some(Payload::TradePrint(trade)) => trade,
            other => panic!("expected a TradePrint, got {other:?}"),
        }
    }

    /// Waits for a heartbeat, which proves nothing else was queued ahead of it.
    async fn expect_only_heartbeats(&mut self) {
        let frame = tokio::time::timeout(Duration::from_secs(3), self.socket.next())
            .await
            .expect("no heartbeat")
            .unwrap()
            .unwrap();
        let message = FeedMessage::decode(frame.into_data()).unwrap();
        assert!(
            matches!(message.payload, Some(Payload::Heartbeat(_))),
            "expected only a heartbeat, got {message:?}"
        );
    }

    fn saw(&self, text: &str) -> bool {
        self.raw
            .iter()
            .any(|frame| frame.windows(text.len()).any(|w| w == text.as_bytes()))
    }
}

#[tokio::test]
async fn a_trade_reaches_subscribers_as_anonymous_prints_and_level_changes() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let (mut watcher, snapshot) = Subscriber::subscribe(gateway.md_addr, &["ACME"]).await;
    assert_eq!((snapshot.symbol_seq, snapshot.bids.len()), (0, 0));

    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    let mut sim = Client::logon(gateway.addr, "SIM").await;
    broker.send(limit("b1", "2", "100", "ACME", "42.10")).await;
    let rested = watcher.delta().await;
    assert_eq!(
        (
            rested.side,
            rested.price_cents,
            rested.qty,
            rested.order_count
        ),
        (Side::Sell as i32, 4210, 100, 1)
    );
    assert_eq!((rested.feed_seq, rested.symbol_seq), (1, 1));

    sim.send(limit("s1", "1", "60", "ACME", "42.10")).await;
    let print = watcher.trade().await;
    assert_eq!((print.price_cents, print.qty), (4210, 60));
    assert_eq!(print.aggressor_side, Side::Buy as i32);
    let level = watcher.delta().await;
    assert_eq!((level.price_cents, level.qty), (4210, 40)); // absolute, not -60
    assert_eq!(level.symbol_seq, 3);

    // Another symbol's activity is not sent, and nothing is waiting behind it.
    broker.send(limit("b2", "1", "10", "BLTZ", "18.75")).await;
    broker.next().await;
    watcher.expect_only_heartbeats().await;

    for private in ["BROKER", "SIM", "acct-1", "ALPHA-1", "ALPHA-2"] {
        assert!(
            !watcher.saw(private),
            "{private} appeared on the public feed"
        );
    }
}

#[tokio::test]
async fn a_subscriber_that_reconnects_carries_on_from_a_snapshot_with_no_gap() {
    let journal = TempData::new();
    let gateway = start_gateway(&journal, MemoryStore::default()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;

    let (mut watcher, _) = Subscriber::subscribe(gateway.md_addr, &["ACME"]).await;
    broker.send(limit("b1", "1", "100", "ACME", "42.00")).await;
    assert_eq!(watcher.delta().await.symbol_seq, 1);
    drop(watcher); // the subscriber dies

    // The market moves on while it is away.
    for (n, price) in ["42.01", "42.02", "42.03"].into_iter().enumerate() {
        broker
            .send(limit(&format!("b{}", n + 2), "1", "10", "ACME", price))
            .await;
        broker.next().await;
    }

    let (mut watcher, snapshot) = Subscriber::subscribe(gateway.md_addr, &["ACME"]).await;
    assert_eq!(
        snapshot.symbol_seq, 4,
        "the snapshot includes what it missed"
    );
    let bids: Vec<i64> = snapshot.bids.iter().map(|l| l.price_cents).collect();
    assert_eq!(bids, [4203, 4202, 4201, 4200]);

    let mut mirror = Mirror::new("ACME");
    mirror.apply(&FeedMessage {
        payload: Some(Payload::Snapshot(snapshot)),
    });
    broker.send(cancel("c1", "b1", "1", "ACME")).await;
    let next = watcher.next().await;
    assert_eq!(mirror.apply(&next), Applied::Applied { symbol_seq: 5 });
    let bids: Vec<i64> = mirror.levels(Side::Buy).iter().map(|l| l.0).collect();
    assert_eq!(bids, [4203, 4202, 4201]);
}

#[tokio::test]
async fn after_a_crash_the_feed_carries_on_with_the_same_numbers() {
    let journal = TempData::new();
    let store = MemoryStore::default();
    let gateway = start_gateway(&journal, store.clone()).await;
    let mut broker = Client::logon(gateway.addr, "BROKER").await;
    let mut sim = Client::logon(gateway.addr, "SIM").await;
    let (mut watcher, _) = Subscriber::subscribe(gateway.md_addr, &["ACME", "BLTZ"]).await;
    broker.send(limit("b1", "1", "100", "ACME", "42.00")).await;
    broker.send(limit("b2", "2", "50", "BLTZ", "18.80")).await;
    sim.send(limit("s1", "2", "30", "ACME", "42.00")).await; // trades with b1
    let mut last = watcher.next().await.feed_seq();
    while last < 4 {
        last = watcher.next().await.feed_seq(); // two rests, then a print and b1's new size
    }
    let session = broker.drop_connection();
    gateway.kill();

    let gateway = start_gateway(&journal, store).await;
    let (_, acme) = Subscriber::subscribe(gateway.md_addr, &["ACME"]).await;
    assert_eq!((acme.feed_seq, acme.symbol_seq), (4, 3), "nothing reset");
    assert_eq!((acme.bids[0].price_cents, acme.bids[0].qty), (4200, 70));

    let (mut watcher, bltz) = Subscriber::subscribe(gateway.md_addr, &["BLTZ"]).await;
    assert_eq!(bltz.symbol_seq, 1);
    let mut broker = Client::reconnect(gateway.addr, session).await;
    broker.send(limit("b4", "2", "5", "BLTZ", "18.85")).await;
    let delta = watcher.delta().await;
    assert_eq!((delta.feed_seq, delta.symbol_seq), (5, 2));
}
