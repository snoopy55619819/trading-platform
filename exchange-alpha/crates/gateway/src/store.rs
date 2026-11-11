//! Where FIX session state lives between restarts: sequence numbers and the outbound
//! messages kept for resend.
//!
//! Behind a trait so the integration tests can run a real gateway against an in-memory store,
//! while production uses the exchange's own Postgres.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use fix_core::Changes;
use sqlx::PgPool;

#[derive(Debug, Clone, Default)]
pub struct StoredSession {
    pub comp_id: String,
    pub next_in_seq: u64,
    pub next_out_seq: u64,
    pub outbound: Vec<(u64, Vec<u8>)>,
}

pub trait SessionStore: Send + 'static {
    fn load_all(&mut self) -> impl Future<Output = Result<Vec<StoredSession>>> + Send;
    fn save(&mut self, comp_id: &str, changes: &Changes)
    -> impl Future<Output = Result<()>> + Send;
}

/// The production store: the exchange's own database.
pub struct PgStore {
    pool: PgPool,
}

impl PgStore {
    /// Applies the gateway's migrations, then hands back a store.
    pub async fn connect(database_url: &str) -> Result<PgStore> {
        let pool = PgPool::connect(database_url).await?;
        sqlx::migrate!().run(&pool).await?;
        Ok(PgStore { pool })
    }
}

impl SessionStore for PgStore {
    async fn load_all(&mut self) -> Result<Vec<StoredSession>> {
        let sessions: Vec<(String, i64, i64)> =
            sqlx::query_as("SELECT comp_id, next_in_seq, next_out_seq FROM fix_sessions")
                .fetch_all(&self.pool)
                .await?;
        let messages: Vec<(String, i64, Vec<u8>)> =
            sqlx::query_as("SELECT comp_id, seq, raw FROM fix_outbound ORDER BY comp_id, seq")
                .fetch_all(&self.pool)
                .await?;

        let mut by_comp: HashMap<String, StoredSession> = sessions
            .into_iter()
            .map(|(comp_id, next_in, next_out)| {
                let session = StoredSession {
                    comp_id: comp_id.clone(),
                    next_in_seq: next_in as u64,
                    next_out_seq: next_out as u64,
                    outbound: Vec::new(),
                };
                (comp_id, session)
            })
            .collect();
        for (comp_id, seq, raw) in messages {
            if let Some(session) = by_comp.get_mut(&comp_id) {
                session.outbound.push((seq as u64, raw));
            }
        }
        Ok(by_comp.into_values().collect())
    }

    async fn save(&mut self, comp_id: &str, changes: &Changes) -> Result<()> {
        // One transaction: sequence numbers and the messages they cover are never out of
        // step with each other.
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO fix_sessions (comp_id, next_in_seq, next_out_seq)
             VALUES ($1, $2, $3)
             ON CONFLICT (comp_id) DO UPDATE
             SET next_in_seq = EXCLUDED.next_in_seq,
                 next_out_seq = EXCLUDED.next_out_seq,
                 updated_at = now()",
        )
        .bind(comp_id)
        .bind(changes.next_in_seq as i64)
        .bind(changes.next_out_seq as i64)
        .execute(&mut *tx)
        .await?;
        if changes.reset {
            sqlx::query("DELETE FROM fix_outbound WHERE comp_id = $1")
                .bind(comp_id)
                .execute(&mut *tx)
                .await?;
        }
        for (seq, raw) in &changes.new_outbound {
            sqlx::query(
                "INSERT INTO fix_outbound (comp_id, seq, raw) VALUES ($1, $2, $3)
                 ON CONFLICT (comp_id, seq) DO UPDATE SET raw = EXCLUDED.raw",
            )
            .bind(comp_id)
            .bind(*seq as i64)
            .bind(raw)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

/// An in-memory store for tests. Cloning shares the same data, so a test can "restart" the
/// gateway and hand the new one the old one's sessions.
#[derive(Clone, Default)]
pub struct MemoryStore {
    sessions: Arc<Mutex<HashMap<String, StoredSession>>>,
}

impl SessionStore for MemoryStore {
    async fn load_all(&mut self) -> Result<Vec<StoredSession>> {
        Ok(self.sessions.lock().unwrap().values().cloned().collect())
    }

    async fn save(&mut self, comp_id: &str, changes: &Changes) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.entry(comp_id.to_string()).or_default();
        session.comp_id = comp_id.to_string();
        session.next_in_seq = changes.next_in_seq;
        session.next_out_seq = changes.next_out_seq;
        if changes.reset {
            session.outbound.clear();
        }
        session
            .outbound
            .extend(changes.new_outbound.iter().cloned());
        Ok(())
    }
}
