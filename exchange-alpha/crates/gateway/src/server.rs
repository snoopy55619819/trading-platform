//! Sockets. Accepts connections and gives each one a task that only moves bytes: decoded
//! frames go to the core, and whatever the core sends back is written out. No decisions are
//! made here.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::Result;
use fix_core::decode;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::core::{ConnId, Core, CoreEvent, Outgoing};
use crate::store::SessionStore;

/// A running gateway.
pub struct Gateway {
    pub addr: SocketAddr,
    core: JoinHandle<Result<()>>,
    acceptor: JoinHandle<()>,
    ticker: JoinHandle<()>,
}

impl Gateway {
    /// Starts serving on `listener`. The core runs on its own task; every connection gets
    /// one more.
    pub fn start<S: SessionStore>(listener: TcpListener, core: Core<S>) -> Result<Gateway> {
        let addr = listener.local_addr()?;
        let (events, inbox) = mpsc::channel(4096);

        let core = tokio::spawn(core.run(inbox));

        let ticks = events.clone();
        let ticker = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                if ticks.send(CoreEvent::Tick).await.is_err() {
                    return;
                }
            }
        });

        let acceptor = tokio::spawn(async move {
            let next_conn = AtomicU64::new(1);
            loop {
                match listener.accept().await {
                    Ok((stream, peer)) => {
                        let conn = next_conn.fetch_add(1, Ordering::Relaxed);
                        info!(conn, %peer, "connected");
                        tokio::spawn(serve(stream, conn, events.clone()));
                    }
                    Err(error) => warn!(%error, "accept failed"),
                }
            }
        });

        info!(%addr, "gateway listening");
        Ok(Gateway {
            addr,
            core,
            acceptor,
            ticker,
        })
    }

    /// Waits for the core to stop, which only happens on a fatal error.
    pub async fn wait(self) -> Result<()> {
        let result = self.core.await;
        self.acceptor.abort();
        self.ticker.abort();
        result?
    }

    /// Stops everything at once, the way a crash would: nothing is flushed or logged out.
    /// Used by tests to check recovery.
    pub fn kill(self) {
        self.acceptor.abort();
        self.ticker.abort();
        self.core.abort();
    }
}

async fn serve(stream: TcpStream, conn: ConnId, core: mpsc::Sender<CoreEvent>) {
    let _ = stream.set_nodelay(true); // small messages; do not wait to batch them
    let (outbox, mut outgoing) = mpsc::unbounded_channel();
    if core
        .send(CoreEvent::Connected { conn, outbox })
        .await
        .is_err()
    {
        return;
    }

    let (mut reader, mut writer) = stream.into_split();
    let mut buffer = Vec::with_capacity(4096);
    loop {
        tokio::select! {
            read = reader.read_buf(&mut buffer) => {
                match read {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        while let Some(decoded) = decode(&mut buffer) {
                            if core.send(CoreEvent::Frame { conn, decoded }).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
            out = outgoing.recv() => match out {
                Some(Outgoing::Bytes(bytes)) => {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Some(Outgoing::Close) | None => break,
            },
        }
    }
    let _ = writer.shutdown().await;
    let _ = core.send(CoreEvent::Disconnected { conn }).await;
}
