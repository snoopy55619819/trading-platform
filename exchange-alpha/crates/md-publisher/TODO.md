# md-publisher — Milestone 3

**The public feed.** Broadcasts book changes to every subscriber. Never learns whose
order moved the book.

Status: **done** · 11 tests (one a property test over random order flow), plus 3 end-to-end
in the gateway

```
cargo run -p gateway                                      # FIX on 9878, this feed on 9879
cargo run -p md-publisher --bin md-watch -- ACME          # live depth ladder
cargo run -p md-publisher --bin md-watch -- ACME --log    # one line per message
```

## Inputs / outputs

| | |
|---|---|
| **In** | `PublicEvent`s from the gateway's core, one batch per command, in journal order |
| **Out** | `Snapshot`, `BookDelta`, `TradePrint`, `Heartbeat` over WebSocket, protobuf-encoded per `spec/marketdata.proto` |
| **Owns** | `feed_seq` (per venue), `symbol_seq` (per symbol), each symbol's book as price levels, the last 1024 messages |
| **Must never emit** | an account id, a participant id, or a `ClOrdID`. The schema has no field for them — keep it that way. |

## Checklist

- [x] `feed_seq`: starts at 1, monotonic, never skips, and never resets: not even across a
      crash, because it is rebuilt from the journal
- [x] `symbol_seq` per symbol, added in spec 1.1.0 (see Decisions)
- [x] Maintain a current snapshot per symbol, truncated to the subscriber's `depth_limit`
- [x] Emit a `BookDelta` per changed price level, with the **absolute new quantity, not a
      difference**
- [x] `qty == 0` means the level is gone
- [x] `TradePrint` with `aggressor_side`, no participants
- [x] `Heartbeat` every second, to every connection
- [x] WebSocket server; `Subscribe`/`Unsubscribe` per symbol
- [x] `ResyncRequest` → send a fresh `Snapshot` (do not replay individual deltas)
- [x] Ring buffer of the last 1024 messages, logged against a `ResyncRequest`
- [x] `prost` codegen from `spec/marketdata.proto` via `build.rs` (with `protox`, so no
      `protoc` install is needed)
- [x] Test: a subscriber that drops and reconnects recovers with no gap
- [x] Test: a slow subscriber does not stall the engine (policy below)

## Done when

A CLI subscriber renders a live depth ladder; killing and restarting it recovers via
snapshot with no gap in `feed_seq`.

**Met.** Against the running exchange, with QuickFIX/Go placing the orders: `md-watch`
followed a trade (`symbol_seq` 1 to 4) and was killed. Another order rested while it was
down, then the exchange itself was `kill -9`'d and restarted. The new `md-watch` got a
snapshot at `symbol_seq` 5 containing the missed order, and the next print was 6.

## Design

```
gateway core ──Vec<PublicEvent>──▶ hub task ──Bytes──▶ connection task ──WS──▶ subscriber
 (journal,       unbounded          (Feed +            bounded, 4096           one each
  engine)                            subscribers)
```

- `public.rs` is the only place an engine event becomes public. It names every field of
  the engine's `Trade` with no `..`, so a new field there will not compile until someone
  decides whether it is public.
- `feed.rs` and `hub.rs` are pure (no sockets, no clock), like `fix-core`'s session, so the
  sequencing and the slow-subscriber policy are unit-tested directly.
- `mirror.rs` is the subscriber's side: snapshot first, ignore what it already covers,
  apply `symbol_seq + 1`, treat anything further ahead as a gap. `md-watch` and the tests use
  it. It is the reference for the broker's own implementation, not a library for it.
- Each message is encoded once and the same bytes go to every subscriber.

## Decisions

- **Two sequence numbers** ([ADR 0001](../../../docs/adr/0001-per-symbol-feed-sequence.md)).
  Subscribers filter by symbol, so one venue-wide `feed_seq` jumps whenever another symbol
  trades and cannot reveal real loss. `symbol_seq` can.
- **Snapshots and heartbeats take no sequence number.** So the numbers are a function of
  the journal alone, and the gateway rebuilds the feed by replaying it.
- **Slow subscribers: buffer 4096 messages, then disconnect.** Never wait, never skip.
  Waiting lets one reader stall everyone; skipping hands it a silently wrong book. A
  disconnected subscriber reconnects and gets a snapshot.
- **Deltas cover every level; `depth_limit` only bounds the snapshot.** Filtering deltas by
  depth would mean synthesising a delta whenever a level moves into view. A subscriber that
  wants a fixed depth trims its own copy.
- **`ts_ns` is when the feed sequenced the message**, not when the engine matched. The
  journal does not record time, so replayed messages carry 0, and are never sent anyway.
- **Unknown symbols in `Subscribe` are ignored.** The schema has no error message.

## Known gaps

- **No backpressure on the core-to-hub channel.** It is unbounded so the engine never waits.
  The hub does much less per event than the core does, so it keeps up, but nothing enforces
  that.
- **Not measured under load.** There is no feed latency or throughput benchmark yet; the
  simulator (M4) is the first thing that will push real volume through it.
- **No TLS and no authentication.** The feed is public by design, but a real venue would
  still meter and authenticate it.
