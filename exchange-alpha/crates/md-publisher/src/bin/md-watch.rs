//! Watches one symbol on Alpha Exchange's market data feed and draws its depth ladder.
//!
//!     cargo run -p md-publisher --bin md-watch -- CRUX
//!     cargo run -p md-publisher --bin md-watch -- CRUX --log
//!
//! `--log` prints one line per message instead of redrawing the ladder: handy for checking
//! sequence numbers by eye, or from a script. Set `ALPHA_MD_URL` to watch another address
//! (default `ws://127.0.0.1:9879`, the published one).
//!
//! On a gap it sends a ResyncRequest and carries on from the fresh snapshot, saying so.

use std::fmt::Write as _;
use std::io::Write as _;

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use matching_engine::PriceCents;
use md_publisher::proto::{
    ClientMessage, FeedMessage, ResyncRequest, Side, Subscribe, client_message, feed_message,
};
use md_publisher::{Applied, Mirror};
use prost::Message as _;
use tokio_tungstenite::tungstenite::Message;

const DEPTH: usize = 10;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(symbol) = args.next() else {
        bail!("usage: md-watch SYMBOL [--log]");
    };
    let log = args.any(|arg| arg == "--log");
    let url = std::env::var("ALPHA_MD_URL").unwrap_or_else(|_| "ws://127.0.0.1:9879".into());

    let (socket, _) = tokio_tungstenite::connect_async(&url)
        .await
        .with_context(|| format!("connecting to {url} (is the exchange running?)"))?;
    let (mut sink, mut source) = socket.split();
    let subscribe = ClientMessage {
        payload: Some(client_message::Payload::Subscribe(Subscribe {
            symbols: vec![symbol.clone()],
            depth_limit: DEPTH as i32,
        })),
    };
    sink.send(Message::Binary(subscribe.encode_to_vec().into()))
        .await?;

    let mut mirror = Mirror::new(&symbol);
    let mut feed_seq = 0;
    let mut resyncs = 0;
    while let Some(frame) = source.next().await {
        let Message::Binary(bytes) = frame? else {
            continue;
        };
        let message = FeedMessage::decode(bytes)?;
        feed_seq = feed_seq.max(message.feed_seq());
        let applied = mirror.apply(&message);
        if let Applied::Gap { .. } = applied {
            resyncs += 1;
            let resync = ClientMessage {
                payload: Some(client_message::Payload::Resync(ResyncRequest {
                    symbols: vec![symbol.clone()],
                    last_good_feed_seq: feed_seq,
                })),
            };
            sink.send(Message::Binary(resync.encode_to_vec().into()))
                .await?;
        }
        if log {
            println!("{}", describe(&message, applied));
        } else {
            draw(&mirror, feed_seq, resyncs);
        }
    }
    println!("feed closed");
    Ok(())
}

fn describe(message: &FeedMessage, applied: Applied) -> String {
    use feed_message::Payload;
    let what = match &message.payload {
        Some(Payload::Snapshot(m)) => format!(
            "SNAPSHOT  feed_seq={} symbol_seq={} bids={} asks={}",
            m.feed_seq,
            m.symbol_seq,
            m.bids.len(),
            m.asks.len()
        ),
        Some(Payload::BookDelta(m)) => format!(
            "DELTA     feed_seq={} symbol_seq={} {} {} qty={} orders={}",
            m.feed_seq,
            m.symbol_seq,
            side(m.side),
            PriceCents(m.price_cents),
            m.qty,
            m.order_count
        ),
        Some(Payload::TradePrint(m)) => format!(
            "TRADE     feed_seq={} symbol_seq={} {} x {} aggressor={}",
            m.feed_seq,
            m.symbol_seq,
            m.qty,
            PriceCents(m.price_cents),
            side(m.aggressor_side)
        ),
        Some(Payload::Heartbeat(m)) => format!("HEARTBEAT feed_seq={}", m.feed_seq),
        None => "EMPTY".to_string(),
    };
    match applied {
        Applied::Gap { expected, received } => {
            format!("{what}  GAP: expected {expected}, got {received}; resync requested")
        }
        _ => what,
    }
}

fn draw(mirror: &Mirror, feed_seq: u64, resyncs: u32) {
    let mut out = String::new();
    // Clear the screen and move to the top-left corner.
    out.push_str("\x1b[2J\x1b[H");
    let seq = mirror
        .symbol_seq()
        .map_or("waiting for snapshot".to_string(), |s| s.to_string());
    let _ = writeln!(
        out,
        "{}  on ALPHA    feed_seq {feed_seq}    symbol_seq {seq}    resyncs {resyncs}",
        mirror.symbol()
    );
    if let Some(trade) = mirror.last_trade() {
        let _ = writeln!(
            out,
            "last trade  {} x {}  ({} aggressor)",
            trade.qty,
            PriceCents(trade.price_cents),
            side(trade.aggressor_side)
        );
    }
    let _ = writeln!(
        out,
        "\n        {:>10} {:>8} {:>7}",
        "PRICE", "QTY", "ORDERS"
    );
    let asks = mirror.levels(Side::Sell);
    for (price, level) in asks.iter().take(DEPTH).rev() {
        let _ = writeln!(
            out,
            "  ask   {:>10} {:>8} {:>7}",
            PriceCents(*price).to_string(),
            level.qty,
            level.order_count
        );
    }
    let bids = mirror.levels(Side::Buy);
    match (bids.first(), asks.first()) {
        (Some((bid, _)), Some((ask, _))) => {
            let _ = writeln!(out, "        ---- spread {} ----", PriceCents(ask - bid));
        }
        _ => out.push_str("        ------------------\n"),
    }
    for (price, level) in bids.iter().take(DEPTH) {
        let _ = writeln!(
            out,
            "  bid   {:>10} {:>8} {:>7}",
            PriceCents(*price).to_string(),
            level.qty,
            level.order_count
        );
    }
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}

fn side(wire: i32) -> &'static str {
    match Side::try_from(wire) {
        Ok(Side::Buy) => "BUY",
        Ok(Side::Sell) => "SELL",
        _ => "?",
    }
}
