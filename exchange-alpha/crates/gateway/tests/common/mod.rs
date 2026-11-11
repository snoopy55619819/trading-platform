//! A test harness: a real gateway on a real TCP port, and FIX clients to talk to it.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use fix_core::tags::*;
use fix_core::*;
use gateway::{Core, Gateway, MemoryStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const COMP_IDS: [&str; 3] = ["BROKER", "SIM", "OTHER"];

/// A journal file removed when the test ends.
pub struct TempJournal(pub PathBuf);

impl TempJournal {
    pub fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        TempJournal(
            std::env::temp_dir().join(format!("gw-test-{}-{n}.journal", std::process::id())),
        )
    }
}

impl Drop for TempJournal {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub async fn start_gateway(journal: &TempJournal, store: MemoryStore) -> Gateway {
    let (core, feed) = Core::open(&journal.0, store, COMP_IDS.map(String::from))
        .await
        .expect("open core");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let md_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    Gateway::start(listener, md_listener, core, feed).unwrap()
}

pub struct Client {
    stream: TcpStream,
    buffer: Vec<u8>,
    pub session: Session,
    inbox: VecDeque<Message>,
    pub closed: bool,
    next_id: u64,
}

impl Client {
    /// Connects and logs on as `comp_id` with a fresh session.
    pub async fn logon(addr: std::net::SocketAddr, comp_id: &str) -> Client {
        let session = Session::new(SessionConfig {
            our_comp_id: comp_id.into(),
            their_comp_id: "ALPHA".into(),
            role: Role::Initiator,
            heartbeat_secs: 30,
        });
        Client::reconnect(addr, session).await
    }

    /// Connects with an existing session, keeping its sequence numbers, as a real client does
    /// after an outage.
    pub async fn reconnect(addr: std::net::SocketAddr, mut session: Session) -> Client {
        let stream = TcpStream::connect(addr).await.unwrap();
        let actions = session.on_connected(UtcMillis::now());
        let mut client = Client {
            stream,
            buffer: Vec::new(),
            session,
            inbox: VecDeque::new(),
            closed: false,
            next_id: 0,
        };
        client.apply(actions).await;
        while !client.session.is_active() {
            client.read_more().await;
            assert!(!client.closed, "the gateway refused the logon");
        }
        client
    }

    /// Drops the connection without logging out, as a crash or network failure would.
    pub fn drop_connection(mut self) -> Session {
        self.session.on_disconnected();
        self.session
    }

    pub async fn send(&mut self, message: Message) {
        let actions = self.session.send(message, UtcMillis::now());
        self.apply(actions).await;
    }

    /// The next application message from the gateway.
    pub async fn next(&mut self) -> Message {
        loop {
            if let Some(message) = self.inbox.pop_front() {
                return message;
            }
            assert!(
                !self.closed,
                "connection closed while waiting for a message"
            );
            self.read_more().await;
        }
    }

    /// Waits briefly and asserts nothing arrives.
    pub async fn expect_silence(&mut self) {
        let wait = tokio::time::timeout(Duration::from_millis(300), self.next()).await;
        if let Ok(message) = wait {
            panic!("expected nothing, got {message:?}");
        }
    }

    /// Reads until the gateway closes the connection.
    pub async fn expect_closed(&mut self) {
        while !self.closed {
            self.read_more().await;
        }
    }

    pub fn fresh_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{}", self.next_id)
    }

    async fn read_more(&mut self) {
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            self.stream.read_buf(&mut self.buffer),
        )
        .await
        .expect("timed out waiting for the gateway");
        match read {
            Ok(0) | Err(_) => {
                self.closed = true;
                return;
            }
            Ok(_) => {}
        }
        while let Some(decoded) = decode(&mut self.buffer) {
            match decoded {
                Decoded::Message(message) => {
                    let actions = self.session.receive(message, UtcMillis::now());
                    self.apply(actions).await;
                }
                Decoded::Garbled(why) => panic!("gateway sent garbage: {why}"),
            }
        }
    }

    async fn apply(&mut self, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Send(bytes) => self.stream.write_all(&bytes).await.unwrap(),
                Action::Deliver(message) => self.inbox.push_back(message),
                Action::Disconnect(_) => self.closed = true,
            }
        }
    }
}

pub fn limit(id: &str, side: &str, qty: &str, symbol: &str, price: &str) -> Message {
    Message::new("D")
        .with(CL_ORD_ID, id)
        .with(ACCOUNT, "acct-1")
        .with(SYMBOL, symbol)
        .with(SIDE, side)
        .with(TRANSACT_TIME, UtcMillis::now().to_fix())
        .with(ORDER_QTY, qty)
        .with(ORD_TYPE, "2")
        .with(PRICE, price)
        .with(TIME_IN_FORCE, "1")
}

pub fn market(id: &str, side: &str, qty: &str, symbol: &str) -> Message {
    Message::new("D")
        .with(CL_ORD_ID, id)
        .with(ACCOUNT, "acct-1")
        .with(SYMBOL, symbol)
        .with(SIDE, side)
        .with(TRANSACT_TIME, UtcMillis::now().to_fix())
        .with(ORDER_QTY, qty)
        .with(ORD_TYPE, "1")
}

pub fn cancel(id: &str, orig: &str, side: &str, symbol: &str) -> Message {
    Message::new("F")
        .with(ORIG_CL_ORD_ID, orig)
        .with(CL_ORD_ID, id)
        .with(ACCOUNT, "acct-1")
        .with(SYMBOL, symbol)
        .with(SIDE, side)
        .with(TRANSACT_TIME, UtcMillis::now().to_fix())
}

/// (ExecType, OrdStatus) of an execution report.
pub fn exec(report: &Message) -> (&str, &str) {
    assert_eq!(
        report.msg_type(),
        "8",
        "expected an ExecutionReport: {report:?}"
    );
    (
        report.get(EXEC_TYPE).unwrap(),
        report.get(ORD_STATUS).unwrap(),
    )
}
