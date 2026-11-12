//! Alpha Exchange. Runs the FIX gateway in front of the matching engine.
//!
//!     cargo run -p gateway
//!
//! Configuration, all optional:
//!
//! | variable          | default                                                          |
//! |-------------------|------------------------------------------------------------------|
//! | `ALPHA_LISTEN`    | `127.0.0.1:9878` (the published order-entry address)             |
//! | `ALPHA_MD_LISTEN` | `127.0.0.1:9879` (the published market data address)             |
//! | `DATABASE_URL`    | `postgres://exchange_alpha:exchange_alpha@127.0.0.1:5433/exchange_alpha` |
//! | `ALPHA_DATA_DIR`  | `data`: each business day's snapshot and journal                 |
//! | `ALPHA_ROLL_EVERY_SECS` | unset: close a day this often too, to watch a roll locally |
//! | `ALPHA_COMP_IDS`  | `BROKER,SIM,QFGO1,QFGO2`: the CompIDs allowed to log on          |
//! | `RUST_LOG`        | `info`                                                           |

use std::path::PathBuf;

use anyhow::{Context, Result};
use gateway::listings::Listings;
use gateway::{Core, DayClock, Gateway, PgStore};
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
    let md_listen = env("ALPHA_MD_LISTEN", "127.0.0.1:9879");
    let database_url = env(
        "DATABASE_URL",
        "postgres://exchange_alpha:exchange_alpha@127.0.0.1:5433/exchange_alpha",
    );
    let data_dir = PathBuf::from(env("ALPHA_DATA_DIR", "data"));
    let mut clock = DayClock::published(&Listings::published());
    if let Ok(secs) = std::env::var("ALPHA_ROLL_EVERY_SECS") {
        let secs = secs
            .parse()
            .context("ALPHA_ROLL_EVERY_SECS must be a whole number")?;
        clock = clock.every(secs);
    }
    let comp_ids: Vec<String> = env("ALPHA_COMP_IDS", "BROKER,SIM,QFGO1,QFGO2")
        .split(',')
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();

    let store = PgStore::connect(&database_url).await.context(
        "connecting to the exchange database (is it up? docker compose -f compose.yml up -d)",
    )?;
    let (core, feed) = Core::open(&data_dir, store, comp_ids.clone(), clock).await?;
    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("binding {listen}"))?;
    let md_listener = TcpListener::bind(&md_listen)
        .await
        .with_context(|| format!("binding {md_listen}"))?;
    let gateway = Gateway::start(listener, md_listener, core, feed)?;
    info!(?comp_ids, data_dir = %data_dir.display(), "Alpha Exchange open");

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
