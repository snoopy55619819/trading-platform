# broker-market-data — Milestone 7

**The broker's market data service.** Live fanout *and* history. Independent of the
backend in every way that matters: own database, own vendored spec, no shared code.

Status: **done** · 6 tests (history against Postgres, rolled back), plus live runs

```
pnpm db:up && pnpm --dir broker/market-data db:migrate     # from the repo root, once
pnpm start                                                  # needs the exchange running
pnpm test
```

| | |
|---|---|
| `GET /history?symbol=ACME&interval=1m&from=<ISO>&to=<ISO>` | candles, oldest first, at most 1,000 |
| `GET /trades?symbol=ACME&limit=50` | the latest trades, newest first, at most 200: seeds the web client's time and sales, since `/live` only sends trades from the moment a browser subscribes |
| `GET /health` | feed state (gaps, reconnects, live books), ticks stored, browsers connected |
| `WS /live` | `{"subscribe": ["ACME"]}`, then `book` and `trade` messages as JSON |

## Inputs / outputs

| | |
|---|---|
| **In** | Alpha Exchange's WebSocket feed, decoded with `marketdata.proto` |
| **Out** | Live prices and depth over WebSocket to `web`; `GET /history` for charts; `GET /trades` for time and sales |
| **Owns** | Its **own database**: `broker-market-data-postgres` on 5434, not a schema in the backend's |

It lives on the anonymous public plane, so it never sees an account or an order id. That
is why it needs nothing from the backend's domain types — and why it could be rewritten in
Go without touching anything else.

## Checklist

- [x] Feed subscriber with **gap detection** on `symbol_seq` (per symbol; `feed_seq` jumps
      whenever another symbol trades, see ADR 0001). A gap means data was lost: send
      `ResyncRequest`, never silently continue. Implemented here from the spec
      (`src/feed/mirror.ts`), not imported.
- [x] Reconnect with backoff, resync on reconnect
- [x] Own compose entry, own database, own migrations (`scripts/migrate.mjs`)
- [x] `ticks(ts, symbol, venue, event_type, price_cents, size, feed_seq)`
- [x] `bars(bucket_ts, symbol, interval, open, high, low, close, volume, trade_count)`
- [x] Rollup job: 1m from ticks, then 5m/1h/1d from 1m
- [x] Late/duplicate ticks are idempotent on `(venue, feed_seq)` (plus `ts_ns`: see Decisions)
- [x] `GET /history?symbol=&interval=&from=&to=` with a sane row cap (1,000 bars)
- [x] WebSocket fanout to browsers: current top-of-book and depth per subscribed symbol
- [x] A slow browser client must not stall ingest — decide the policy and write it down
- [x] Test: replay a recorded feed, assert candles match a hand-computed expectation
- [x] Test: kill mid-stream, restart, no gap and no duplicate bars

## Done when

Chart-ready OHLCV for any symbol over any window, and a browser sees prices tick live.

**Met**, against the running exchange with the simulator trading:

- `/history` serves 1m, 5m, 1h and 1d candles for every symbol; bad symbols, intervals and
  oversized ranges get a 400 that says what to fix.
- A browser page subscribed to ACME on `/live` and showed the book and trades updating
  (13 conflated book updates and 3 trades in 10 seconds).
- **Killed mid-stream:** market-data was `kill -9`'d, left down for 10 seconds while trading
  went on, and restarted. It resubscribed with no gaps; a check that recomputes every bar
  in every interval from the raw ticks found no mismatch and no duplicate tick.
- Tests: hand-computed candles across minute, five-minute and business-day boundaries; a
  late tick folding into an already-rolled-up bar; repeats changing nothing; 90 seconds of
  the real feed (`test/fixtures/alpha-feed-90s.b64`) replayed and matched against an
  independent tally; conflation; the slow-client cut-off. Mutation-checked: taking the
  open from the wrong end, or recomputing only new ticks instead of whole buckets, each
  fails a test.

## Design

```
Alpha feed (protobuf, WS) -> Subscriber + Mirror per symbol -> trades -> ticks (batched, 250 ms)
                                      |                                     |
                                   books                       rollup every second -> bars
                                      v                                     v
                        WS /live to browsers (JSON)               GET /history
```

## Decisions

- **Its own Postgres server**, not a schema in the backend's: a second service in
  `broker/compose.yml`, its own role and volume, and its own migration runner. The
  workload (continuous append, time-range reads) is headed for a columnar store, and only
  this service should have to change for that.
- **Ticks are trades only.** Book changes are far more numerous and nothing in v1 needs
  their history; the live book is served from memory.
- **A tick is stored once, keyed on `(venue, feed_seq, ts_ns)`.** `feed_seq` alone identifies
  a message while the venue lives, and it carries on across a venue restart. Adding the
  venue's timestamp keeps a venue whose history was wiped (its numbering starts again at
  1, which happens in development all the time) from colliding with what came before.
  Found by the replay test itself, which at first stored nothing: the fixture's trades
  were already in the database from the live run that recorded them.
- **Bars are recomputed, never incremented.** Each rollup rebuilds every bucket that gained
  a tick since the last run, from scratch, and replaces it. Late ticks land correctly,
  running twice changes nothing, and a restart cannot double a bar. 5m, 1h and 1d come
  from 1m bars, not from ticks.
- **Daily bars follow the venue's business day**, which rolls at 21:00 UTC (from
  `listings.json`), not at UTC midnight.
- **Only buckets with trades have a bar.** A chart draws the rest as gaps, which is what
  they are.
- **Browsers get JSON, not the venue's protobuf.** This is the broker's own protocol to its
  own client; browsers never talk to the exchange.
- **Slow browsers: conflate, then cut off.** Books go out at most every 100 ms per symbol,
  latest state only; trades go out as they happen. A browser whose send queue passes 1 MB
  is disconnected; reconnecting gets the current books at once. Ingest never waits for a
  browser.
- **A stale book is shown as stale** (`"live": false`) rather than with prices nobody can
  trust, until its new snapshot arrives.

## Known gaps

- **Trades missed are lost for good.** While this service is down, or across a feed gap,
  the venue's spec offers only a fresh snapshot, never a replay, so those trades never
  reach history and those minutes' candles are thinner. The fix belongs to the exchange:
  serve recent prints from md-publisher's ring buffer on request.
- **Up to 250 ms of received trades** are lost if the process is killed between batches;
  the same loss as being down for that long.
- **One writer only.** The rollup's watermark assumes this process is the only thing
  inserting ticks, one batch at a time.
- **No retention.** Ticks are kept forever.
