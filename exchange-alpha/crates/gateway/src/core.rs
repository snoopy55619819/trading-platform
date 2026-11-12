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
//!
//! The core also hands the public part of every command's events to market data. It never
//! waits for market data: the channel is unbounded, and the feed sequences and fans out on
//! its own task.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use anyhow::{Context, Result};
use fix_core::tags::{msg_type, *};
use fix_core::{Action, Decoded, Message, Role, Session, SessionConfig, UtcMillis};
use matching_engine::{Command, EndOfDay, JournaledEngine};
use md_publisher::{Feed, PublicEvent, Publisher, Sequence};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::days::{DataDir, Day, DayClock};
use crate::listings::Listings;
use crate::orders::{OrderTracker, Report};
use crate::recovery::{ExchangeState, Recovered, recover};
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
    /// Where public events go. `None` until the gateway starts the market data server.
    market_data: Option<Publisher>,
    /// The feed's numbering, kept in step with the feed (which lives on its own task) so a
    /// snapshot can be taken here without asking it.
    feed_sequence: Sequence,
    /// Where each day's snapshot and journal go.
    data: DataDir,
    clock: DayClock,
    /// The business day the journal is currently recording.
    business_date: String,
    /// When the current business day closes.
    next_roll: UtcMillis,
}

impl<S: SessionStore> Core<S> {
    /// Opens the data directory and rebuilds the exchange from the newest snapshot plus that
    /// day's journal (the book, every order's state and the market data feed), then loads
    /// the FIX sessions from the store.
    ///
    /// Returns the rebuilt feed alongside the core, for the market data server to serve.
    /// Its sequence numbers carry on from where they were.
    pub async fn open(
        data_dir: impl Into<PathBuf>,
        store: S,
        allowed_comp_ids: impl IntoIterator<Item = String>,
        clock: DayClock,
    ) -> Result<(Core<S>, Feed)> {
        Self::open_at(data_dir, store, allowed_comp_ids, clock, UtcMillis::now()).await
    }

    /// [`open`](Self::open) as if the time were `now`. Tests use it to be closed over a roll.
    ///
    /// Two situations finish with a roll before anything else happens:
    /// - the journal ends with a close: the exchange stopped part way through a roll, so the
    ///   next day's snapshot and journal are written now;
    /// - the business date has moved on since the snapshot: the exchange was down at the roll
    ///   time, so the day is closed now.
    pub async fn open_at(
        data_dir: impl Into<PathBuf>,
        mut store: S,
        allowed_comp_ids: impl IntoIterator<Item = String>,
        clock: DayClock,
        now: UtcMillis,
    ) -> Result<(Core<S>, Feed)> {
        let listings = Listings::published();
        let data = DataDir::open(data_dir)?;
        let (day, state) = match data.latest()? {
            Some(latest) => latest,
            None => {
                let day = Day {
                    business_date: clock.business_date(now),
                    first_seq: 1,
                };
                data.write_snapshot(&day, &ExchangeState::empty())?;
                (day, ExchangeState::empty())
            }
        };
        let Recovered {
            engine,
            orders,
            feed,
            ended_with_close,
        } = recover(&listings, &data.journal(&day), Some(state))?;

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
            business_date = day.business_date,
            commands = engine.recovered(),
            open_orders = orders.open_order_count(),
            feed_seq = feed.feed_seq(),
            "recovered from the day's snapshot and journal"
        );
        let mut core = Core {
            engine,
            orders,
            listings,
            store,
            allowed_comp_ids: allowed_comp_ids.into_iter().collect(),
            sessions,
            connections: HashMap::new(),
            rejections: 0,
            market_data: None,
            feed_sequence: feed.sequence().clone(),
            data,
            clock,
            business_date: day.business_date,
            next_roll: clock.next_roll(now),
        };

        let rolled = if ended_with_close {
            info!("the last run stopped during a roll; finishing it");
            core.start_next_day(now)?;
            true
        } else if clock.business_date(now) > core.business_date {
            info!("closed through a roll; closing the day now");
            core.end_day(now)?;
            true
        } else {
            false
        };
        let feed = if rolled {
            // The close changed the book while no feed was attached. The feed is its
            // numbering plus the engine's levels, so rebuild it from those.
            core.persist().await?;
            Feed::restore(
                core.listings.venue.clone(),
                core.listings.tickers(),
                core.feed_sequence.clone(),
                &core.engine.engine().snapshot(),
            )
        } else {
            feed
        };
        Ok((core, feed))
    }

    /// Closes the business day: journals the close (every resting day order expires, and
    /// each owner gets an `ExecutionReport` saying so), then starts the next day.
    pub fn end_day(&mut self, now: UtcMillis) -> Result<()> {
        let business_date = self.business_date.clone();
        info!(business_date, "closing the business day");
        let reports = self.submit(Command::EndOfDay(EndOfDay { business_date }))?;
        self.send_reports(reports, now);
        self.start_next_day(now)
    }

    /// Writes the snapshot that begins the next business day and moves the journal to that
    /// day's file. The snapshot is complete on disk before the new journal gets an entry, so
    /// a crash at any point leaves either the old day (finished on the next start) or the new.
    fn start_next_day(&mut self, now: UtcMillis) -> Result<()> {
        let state = self.state();
        let day = Day {
            business_date: self.clock.business_date(now),
            first_seq: state.journal_seq + 1,
        };
        self.data
            .write_snapshot(&day, &state)
            .context("writing the day's snapshot")?;
        let journal = self.data.journal(&day);
        self.engine
            .continue_in(&journal)
            .with_context(|| format!("starting {}", journal.display()))?;
        info!(
            business_date = day.business_date,
            first_seq = day.first_seq,
            open_orders = self.orders.open_order_count(),
            "business day started"
        );
        self.business_date = day.business_date;
        self.next_roll = self.clock.next_roll(now);
        Ok(())
    }

    /// The state a snapshot records. Only meaningful between commands, which is the only
    /// time anything outside `handle` can call it.
    pub fn state(&self) -> ExchangeState {
        ExchangeState::capture(&self.engine, &self.orders, &self.feed_sequence)
    }

    /// Starts sending public events to `publisher`.
    pub fn publish_to(&mut self, publisher: Publisher) {
        self.market_data = Some(publisher);
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
        self.publish(&events);
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

    /// Sends the public part of `events` to market data, as one batch so the feed sees each
    /// command's changes together and in journal order.
    fn publish(&mut self, events: &[matching_engine::Event]) {
        let public: Vec<PublicEvent> = events.iter().filter_map(PublicEvent::from_event).collect();
        // Numbered whether or not anyone is listening, exactly as replay numbers them.
        for event in &public {
            self.feed_sequence.next(event.symbol());
        }
        let Some(market_data) = &self.market_data else {
            return;
        };
        if !public.is_empty() && market_data.send(public).is_err() {
            // Order entry carries on without a feed; subscribers will see heartbeats stop.
            warn!("market data has stopped; no longer publishing");
            self.market_data = None;
        }
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
        if now >= self.next_roll {
            self.end_day(now)?;
        }

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
