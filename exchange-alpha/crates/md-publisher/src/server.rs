//! Sockets. One task runs the hub; every WebSocket connection gets a task that only moves
//! bytes, the same split as the FIX gateway.
//!
//! The gateway's core sends public events in through a [`Publisher`]. That channel is
//! unbounded on purpose: the core must never wait on market data. It cannot grow without
//! limit in practice, because the hub's work per event is a map update and a few
//! `try_send`s, far less than the core spends matching and journaling the same command.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::feed::Feed;
use crate::hub::{Hub, SUBSCRIBER_BUFFER, SubscriberId};
use crate::now_ns;
use crate::proto::ClientMessage;
use crate::public::PublicEvent;

/// Where the gateway sends each command's public events, in journal order.
pub type Publisher = mpsc::UnboundedSender<Vec<PublicEvent>>;

enum FromConnection {
    Connected {
        id: SubscriberId,
        outbox: mpsc::Sender<Bytes>,
    },
    Client {
        id: SubscriberId,
        message: ClientMessage,
    },
    Disconnected {
        id: SubscriberId,
    },
}

/// A running market data server.
pub struct MarketData {
    pub addr: SocketAddr,
    publisher: Publisher,
    hub: JoinHandle<()>,
    acceptor: JoinHandle<()>,
}

impl MarketData {
    /// Serves `feed` on `listener`, sending a heartbeat to every connection each
    /// `heartbeat` interval.
    pub fn start(
        listener: TcpListener,
        feed: Feed,
        heartbeat: Duration,
    ) -> std::io::Result<MarketData> {
        let addr = listener.local_addr()?;
        let (publisher, events) = mpsc::unbounded_channel();
        let (connections, inbox) = mpsc::channel(1024);

        let hub = tokio::spawn(run_hub(Hub::new(feed), events, inbox, heartbeat));
        let acceptor = tokio::spawn(async move {
            let next_id = AtomicU64::new(1);
            loop {
                match listener.accept().await {
                    Ok((stream, peer)) => {
                        let id = next_id.fetch_add(1, Ordering::Relaxed);
                        info!(subscriber = id, %peer, "market data connection");
                        tokio::spawn(serve(stream, id, connections.clone()));
                    }
                    Err(error) => warn!(%error, "market data accept failed"),
                }
            }
        });

        info!(%addr, "market data listening");
        Ok(MarketData {
            addr,
            publisher,
            hub,
            acceptor,
        })
    }

    pub fn publisher(&self) -> Publisher {
        self.publisher.clone()
    }

    /// Stops serving. Subscribers see their connections drop.
    pub fn stop(self) {
        self.acceptor.abort();
        self.hub.abort();
    }
}

async fn run_hub(
    mut hub: Hub,
    mut events: mpsc::UnboundedReceiver<Vec<PublicEvent>>,
    mut connections: mpsc::Receiver<FromConnection>,
    heartbeat: Duration,
) {
    let mut timer = tokio::time::interval(heartbeat);
    loop {
        tokio::select! {
            batch = events.recv() => match batch {
                Some(batch) => hub.publish(&batch, now_ns()),
                None => return, // the gateway is gone
            },
            Some(from) = connections.recv() => match from {
                FromConnection::Connected { id, outbox } => hub.connect(id, outbox),
                FromConnection::Client { id, message } => hub.on_client(id, message, now_ns()),
                FromConnection::Disconnected { id } => hub.disconnect(id),
            },
            _ = timer.tick() => hub.heartbeat(now_ns()),
        }
    }
}

async fn serve(stream: TcpStream, id: SubscriberId, hub: mpsc::Sender<FromConnection>) {
    let _ = stream.set_nodelay(true);
    let socket = match tokio_tungstenite::accept_async(stream).await {
        Ok(socket) => socket,
        Err(error) => {
            warn!(subscriber = id, %error, "not a WebSocket handshake");
            return;
        }
    };
    let (mut sink, mut source) = socket.split();
    let (outbox, mut outgoing) = mpsc::channel(SUBSCRIBER_BUFFER);
    if hub
        .send(FromConnection::Connected { id, outbox })
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            frame = source.next() => match frame {
                Some(Ok(Message::Binary(bytes))) => match ClientMessage::decode(bytes) {
                    Ok(message) => {
                        if hub.send(FromConnection::Client { id, message }).await.is_err() {
                            break;
                        }
                    }
                    Err(error) => warn!(subscriber = id, %error, "undecodable client message"),
                },
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                // Pings are answered by the library; text frames are not part of the protocol.
                Some(Ok(_)) => {}
            },
            out = outgoing.recv() => match out {
                Some(bytes) => {
                    if sink.send(Message::Binary(bytes)).await.is_err() {
                        break;
                    }
                }
                // The hub dropped us: we fell too far behind.
                None => break,
            },
        }
    }
    // A subscriber dropped for being slow may not be reading at all, so do not wait long
    // for the close handshake.
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
    let _ = hub.send(FromConnection::Disconnected { id }).await;
    info!(subscriber = id, "market data connection closed");
}
