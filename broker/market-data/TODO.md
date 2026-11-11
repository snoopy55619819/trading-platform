# broker-market-data — Milestone 7

**The broker's market data service.** Live fanout *and* history. Independent of the
backend in every way that matters: own database, own vendored spec, no shared code.

Status: **not started** · depends on: md-publisher (M3)

## Inputs / outputs

| | |
|---|---|
| **In** | Alpha Exchange's WebSocket feed, decoded with `marketdata.proto` |
| **Out** | Live prices and depth over WebSocket to `web`; `GET /history` for charts |
| **Owns** | Its **own database** — created at this milestone, not a schema in the backend's |

It lives on the anonymous public plane, so it never sees an account or an order id. That
is why it needs nothing from the backend's domain types — and why it could be rewritten in
Go without touching anything else.

## Checklist

- [ ] Feed subscriber with **gap detection** on `symbol_seq` (per symbol; `feed_seq` jumps
      whenever another symbol trades, see ADR 0001). A gap means data was lost: send
      `ResyncRequest`, never silently continue. The exchange's `md-publisher/src/mirror.rs`
      is the reference for the rules; implement them here, do not import it.
- [ ] Reconnect with backoff, resync on reconnect
- [ ] Own compose entry, own database, own migrations
- [ ] `ticks(ts, symbol, venue, event_type, price_cents, size, feed_seq)`
- [ ] `bars(bucket_ts, symbol, interval, open, high, low, close, volume, trade_count)`
- [ ] Rollup job: 1m from ticks, then 5m/1h/1d from 1m
- [ ] Late/duplicate ticks are idempotent on `(venue, feed_seq)`
- [ ] `GET /history?symbol=&interval=&from=&to=` with a sane row cap
- [ ] WebSocket fanout to browsers: current top-of-book and depth per subscribed symbol
- [ ] A slow browser client must not stall ingest — decide the policy and write it down
- [ ] Test: replay a recorded feed, assert candles match a hand-computed expectation
- [ ] Test: kill mid-stream, restart, no gap and no duplicate bars

## Done when

Chart-ready OHLCV for any symbol over any window, and a browser sees prices tick live.
