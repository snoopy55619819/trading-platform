//! The gateway's single-threaded core.
//!
//! One task owns the matching engine, the order tracker and every FIX session. Connection
//! tasks only move bytes: they decode frames and send them here, and write whatever comes
//! back. Because only this task touches state, matching stays single-threaded and
//! deterministic however many clients are connected, and no locks are needed anywhere.
//!
//! Sessions are keyed by CompID, not by connection. When a client is disconnected its session
//! lives on: reports for its orders are still numbered and stored, and when it reconnects the
//! sequence numbers show the gap and the session layer resends them.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use fix_core::tags::{msg_type, *};
use fix_core::{Action, Decoded, Message, Role, Session, SessionConfig, UtcMillis};
use matching_engine::{Command, JournaledEngine};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::listings::Listings;
use crate::orders::{OrderTracker, Report};
use crate::store::SessionStore;

pub type ConnId = u64;

/// How long a new connection has to send its Logon before it is dropped.
const LOGON_TIMEOUT_MS: u64 = 10_000;

/// What connection tasks (and the timer) tell the core.
pub enum CoreEvent {
    Connected {
        conn: ConnId,
        outbox: mpsc::UnboundedSender<Outgoing>,
    },
    Frame {
        conn: ConnId,
        decoded: Decoded,
    },
    Disconnected {
        conn: ConnId,
    },
    Tick,
}

/// What the core tells a connection task.
pub enum Outgoing {
    Bytes(Vec<u8>),
    Close,
}

struct Connection {
    outbox: mpsc::UnboundedSender<Outgoing>,
    /// Set once the connection has logged on.
    comp_id: Option<String>,
    connected_at: UtcMillis,
}

pub struct Core<S: SessionStore> {
    engine: JournaledEngine,
    orders: OrderTracker,
    listings: Listings,
    store: S,
    allowed_comp_ids: HashSet<String>,
    sessions: HashMap<String, Session>,
    connections: HashMap<ConnId, Connection>,
    /// Numbers execution ids for orders rejected before reaching the engine (those have no
    /// journal sequence number to derive one from).
    rejections: u64,
}

impl<S: SessionStore> Core<S> {
    /// Opens the journal (replaying it to rebuild the book and every order's state) and loads
    /// the FIX sessions from the store.
    pub async fn open(
        journal: &Path,
        mut store: S,
        allowed_comp_ids: impl IntoIterator<Item = String>,
    ) -> Result<Core<S>> {
        let listings = Listings::published();
        let mut orders = OrderTracker::new(&listings);
        let engine = JournaledEngine::open_observing(journal, |event| {
            orders.apply(event, &listings);
        })
        .with_context(|| format!("opening journal {}", journal.display()))?;

        let sessions = store
            .load_all()
            .await?
            .into_iter()
            .map(|stored| {
                let config = session_config(&listings.venue, &stored.comp_id);
                let session = Session::restore(
                    config,
                    stored.next_in_seq,
                    stored.next_out_seq,
                    stored.outbound,
                );
                (stored.comp_id, session)
            })
            .collect();

        info!(
            commands = engine.recovered(),
            open_orders = orders.open_order_count(),
            "recovered from journal"
        );
        Ok(Core {
            engine,
            orders,
            listings,
            store,
            allowed_comp_ids: allowed_comp_ids.into_iter().collect(),
            sessions,
            connections: HashMap::new(),
            rejections: 0,
        })
    }

    /// Processes events until every sender is gone. Returns an error only for failures that
    /// must stop the exchange, such as being unable to write the journal.
    pub async fn run(mut self, mut events: mpsc::Receiver<CoreEvent>) -> Result<()> {
        while let Some(event) = events.recv().await {
            self.handle(event, UtcMillis::now())?;
            self.persist().await?;
        }
        Ok(())
    }

    fn handle(&mut self, event: CoreEvent, now: UtcMillis) -> Result<()> {
        match event {
            CoreEvent::Connected { conn, outbox } => {
                let connection = Connection {
                    outbox,
                    comp_id: None,
                    connected_at: now,
                };
                self.connections.insert(conn, connection);
            }
            CoreEvent::Frame {
                conn,
                decoded: Decoded::Garbled(why),
            } => {
                // FIX rule: ignore it without consuming a sequence number. The counterparty
                // will see the gap and resend.
                warn!(conn, why, "discarded garbled message");
            }
            CoreEvent::Frame {
                conn,
                decoded: Decoded::Message(message),
            } => self.on_message(conn, message, now)?,
            CoreEvent::Disconnected { conn } => {
                let comp_id = self.connections.remove(&conn).and_then(|c| c.comp_id);
                if let Some(comp_id) = comp_id {
                    self.session(&comp_id).on_disconnected();
                    info!(comp_id, "disconnected");
                }
            }
            CoreEvent::Tick => self.tick(now)?,
        }
        Ok(())
    }

    fn on_message(&mut self, conn: ConnId, message: Message, now: UtcMillis) -> Result<()> {
        let Some(connection) = self.connections.get(&conn) else {
            return Ok(());
        };
        let comp_id = match connection.comp_id.clone() {
            Some(comp_id) => comp_id,
            None => match self.bind(conn, &message, now) {
                Some(comp_id) => comp_id,
                None => return Ok(()),
            },
        };
        let actions = self.session(&comp_id).receive(message, now);
        self.dispatch(&comp_id, actions, now)
    }

    /// The first message on a connection decides which session it belongs to. Only a Logon
    /// from a known CompID, for us, with no other connection already logged on, is accepted.
    fn bind(&mut self, conn: ConnId, logon: &Message, now: UtcMillis) -> Option<String> {
        let sender = logon.get(SENDER_COMP_ID).unwrap_or_default().to_string();
        let refusal = if logon.msg_type() != msg_type::LOGON {
            Some("the first message must be a Logon")
        } else if logon.get(TARGET_COMP_ID) != Some(self.listings.venue.as_str()) {
            Some("TargetCompID is not this venue")
        } else if !self.allowed_comp_ids.contains(&sender) {
            Some("unknown SenderCompID")
        } else if self
            .connections
            .values()
            .any(|c| c.comp_id.as_deref() == Some(sender.as_str()))
        {
            Some("this CompID already has a session logged on")
        } else {
            None
        };
        if let Some(why) = refusal {
            warn!(conn, sender, why, "refused logon");
            self.close_connection(conn);
            return None;
        }

        self.connections.get_mut(&conn)?.comp_id = Some(sender.clone());
        let session = self.session(&sender);
        let actions = session.on_connected(now);
        // An acceptor sends nothing on connect, so there is nothing to dispatch.
        debug_assert!(actions.is_empty());
        info!(comp_id = sender, "logon");
        Some(sender)
    }

    fn dispatch(&mut self, comp_id: &str, actions: Vec<Action>, now: UtcMillis) -> Result<()> {
        for action in actions {
            match action {
                Action::Send(bytes) => self.write(comp_id, bytes),
                Action::Disconnect(why) => {
                    info!(comp_id, why, "closing session");
                    self.close_session(comp_id);
                }
                Action::Deliver(message) => self.on_application(comp_id, message, now)?,
            }
        }
        Ok(())
    }

    fn on_application(&mut self, comp_id: &str, message: Message, now: UtcMillis) -> Result<()> {
        let reports = match message.msg_type() {
            msg_type::NEW_ORDER_SINGLE => {
                match self
                    .orders
                    .new_order_single(comp_id, &message, &self.listings)
                {
                    Ok(command) => self.submit(command)?,
                    Err(rejection) => vec![self.number_rejection(rejection, now)],
                }
            }
            msg_type::ORDER_CANCEL_REQUEST => match self.orders.cancel_request(comp_id, &message) {
                Ok(command) => self.submit(command)?,
                Err(rejection) => vec![rejection],
            },
            msg_type::REJECT => {
                warn!(
                    comp_id,
                    text = message.get(TEXT),
                    "client rejected one of our messages"
                );
                Vec::new()
            }
            other => {
                // Valid FIX, but not something a client may send to an exchange.
                let reject = Message::new(msg_type::REJECT)
                    .with(REF_SEQ_NUM, message.get(MSG_SEQ_NUM).unwrap_or("0"))
                    .with(REF_MSG_TYPE, other)
                    .with(SESSION_REJECT_REASON, "11")
                    .with(
                        TEXT,
                        format!("MsgType {other} is not accepted by the exchange"),
                    );
                vec![Report {
                    comp_id: comp_id.to_string(),
                    message: reject,
                }]
            }
        };
        self.send_reports(reports, now);
        Ok(())
    }

    /// Journals the command, applies it, and turns the resulting events into reports.
    /// Failing to write the journal is fatal: the command was not applied, and an exchange
    /// that cannot record what it does must stop.
    fn submit(&mut self, command: Command) -> Result<Vec<Report>> {
        let events = self.engine.submit(command).context("writing the journal")?;
        let seq = self.engine.last_seq();
        let mut reports = Vec::new();
        for event in &events {
            reports.extend(self.orders.apply(event, &self.listings));
        }
        // ExecIDs derive from the journal sequence number, which replay reproduces exactly,
        // so they stay unique across restarts with nothing extra to persist.
        for (n, report) in reports.iter_mut().enumerate() {
            if report.message.msg_type() == msg_type::EXECUTION_REPORT {
                report.message.set(EXEC_ID, format!("{seq}-{n}"));
            }
        }
        Ok(reports)
    }

    fn number_rejection(&mut self, mut report: Report, now: UtcMillis) -> Report {
        self.rejections += 1;
        report
            .message
            .set(EXEC_ID, format!("R{}-{}", now.0, self.rejections));
        report
    }

    fn send_reports(&mut self, reports: Vec<Report>, now: UtcMillis) {
        for mut report in reports {
            if report.message.msg_type() == msg_type::EXECUTION_REPORT {
                report.message.set(TRANSACT_TIME, now.to_fix());
            }
            // Numbered and stored even if that client is offline right now; it gets them by
            // resend when it logs back on.
            let actions = self.session(&report.comp_id).send(report.message, now);
            for action in actions {
                if let Action::Send(bytes) = action {
                    self.write(&report.comp_id, bytes);
                }
            }
        }
    }

    fn tick(&mut self, now: UtcMillis) -> Result<()> {
        let stale: Vec<ConnId> = self
            .connections
            .iter()
            .filter(|(_, c)| c.comp_id.is_none() && now.since(c.connected_at) > LOGON_TIMEOUT_MS)
            .map(|(conn, _)| *conn)
            .collect();
        for conn in stale {
            warn!(conn, "no Logon in time");
            self.close_connection(conn);
        }

        let logged_on: Vec<String> = self
            .connections
            .values()
            .filter_map(|c| c.comp_id.clone())
            .collect();
        for comp_id in logged_on {
            let actions = self.session(&comp_id).tick(now);
            self.dispatch(&comp_id, actions, now)?;
        }
        Ok(())
    }

    async fn persist(&mut self) -> Result<()> {
        for (comp_id, session) in &mut self.sessions {
            if let Some(changes) = session.take_changes() {
                self.store
                    .save(comp_id, &changes)
                    .await
                    .with_context(|| format!("saving FIX session {comp_id}"))?;
            }
        }
        Ok(())
    }

    fn session(&mut self, comp_id: &str) -> &mut Session {
        let venue = &self.listings.venue;
        self.sessions
            .entry(comp_id.to_string())
            .or_insert_with(|| Session::new(session_config(venue, comp_id)))
    }

    fn write(&self, comp_id: &str, bytes: Vec<u8>) {
        if let Some(connection) = self.connection_of(comp_id) {
            let _ = connection.outbox.send(Outgoing::Bytes(bytes));
        }
    }

    fn close_session(&mut self, comp_id: &str) {
        if let Some(conn) = self
            .connections
            .iter()
            .find(|(_, c)| c.comp_id.as_deref() == Some(comp_id))
            .map(|(conn, _)| *conn)
        {
            self.close_connection(conn);
        }
        self.session(comp_id).on_disconnected();
    }

    fn close_connection(&mut self, conn: ConnId) {
        if let Some(connection) = self.connections.get_mut(&conn) {
            let _ = connection.outbox.send(Outgoing::Close);
            connection.comp_id = None;
        }
    }

    fn connection_of(&self, comp_id: &str) -> Option<&Connection> {
        self.connections
            .values()
            .find(|c| c.comp_id.as_deref() == Some(comp_id))
    }
}

fn session_config(venue: &str, comp_id: &str) -> SessionConfig {
    SessionConfig {
        our_comp_id: venue.to_string(),
        their_comp_id: comp_id.to_string(),
        role: Role::Acceptor,
        heartbeat_secs: 30, // replaced by whatever the client's Logon asks for
    }
}
