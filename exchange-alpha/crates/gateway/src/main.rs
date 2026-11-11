//! Alpha Exchange. Runs the FIX gateway in front of the matching engine.
//!
//!     cargo run -p gateway
//!
//! Configuration, all optional:
//!
//! | variable          | default                                                          |
//! |-------------------|------------------------------------------------------------------|
//! | `ALPHA_LISTEN`    | `127.0.0.1:9878` (the published order-entry address)             |
//! | `DATABASE_URL`    | `postgres://exchange_alpha:exchange_alpha@127.0.0.1:5433/exchange_alpha` |
//! | `ALPHA_JOURNAL`   | `data/alpha.journal`                                             |
//! | `ALPHA_COMP_IDS`  | `BROKER,SIM,QFGO1,QFGO2`: the CompIDs allowed to log on          |
//! | `RUST_LOG`        | `info`                                                           |

use std::path::PathBuf;

use anyhow::{Context, Result};
use gateway::{Core, Gateway, PgStore};
use tokio::net::TcpListener;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let listen = env("ALPHA_LISTEN", "127.0.0.1:9878");
    let database_url = env(
        "DATABASE_URL",
        "postgres://exchange_alpha:exchange_alpha@127.0.0.1:5433/exchange_alpha",
    );
    let journal = PathBuf::from(env("ALPHA_JOURNAL", "data/alpha.journal"));
    let comp_ids: Vec<String> = env("ALPHA_COMP_IDS", "BROKER,SIM,QFGO1,QFGO2")
        .split(',')
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();

    if let Some(dir) = journal.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let store = PgStore::connect(&database_url).await.context(
        "connecting to the exchange database (is it up? docker compose -f compose.yml up -d)",
    )?;
    let core = Core::open(&journal, store, comp_ids.clone()).await?;
    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("binding {listen}"))?;
    let gateway = Gateway::start(listener, core)?;
    info!(?comp_ids, journal = %journal.display(), "Alpha Exchange open");

    tokio::select! {
        result = gateway.wait() => {
            if let Err(error) = &result {
                error!("stopping: {error:#}");
            }
            result
        }
        _ = tokio::signal::ctrl_c() => {
            // The journal and the session store are written before anything is acknowledged,
            // so stopping here loses nothing.
            info!("shutting down");
            Ok(())
        }
    }
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}
