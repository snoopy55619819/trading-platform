# md-publisher — Milestone 3

**The public feed.** Broadcasts book changes to every subscriber. Never learns whose
order moved the book.

Status: **not started** · depends on: `matching-engine`

## Inputs / outputs

| | |
|---|---|
| **In** | `BookDelta` and `Trade` events from the engine |
| **Out** | `Snapshot`, `BookDelta`, `TradePrint`, `Heartbeat` over WebSocket, protobuf-encoded per `spec/marketdata.proto` |
| **Owns** | `feed_seq` (monotonic per venue), the current snapshot per symbol, a ring buffer of recent messages |
| **Must never emit** | an account id, a participant id, or a `ClOrdID`. The schema has no field for them — keep it that way. |

This is the **first Rust consumer of protobuf**, so `prost`/`tonic-build` gets wired here
and not before.

## Checklist

- [ ] `feed_seq`: starts at 1, monotonic, never resets while the venue is up, never skips
- [ ] Maintain a current snapshot per symbol, truncated to `depth_limit` levels
- [ ] Emit a `BookDelta` per changed price level — **absolute new quantity, not a
      difference.** Absolute values survive a mis-sequenced replay; differences don't.
- [ ] `qty == 0` means the level is gone
- [ ] `TradePrint` with `aggressor_side`, no participants
- [ ] `Heartbeat` on a timer, so a subscriber can tell a quiet market from a dead feed
- [ ] WebSocket server; `Subscribe`/`Unsubscribe` per symbol
- [ ] `ResyncRequest` → send a fresh `Snapshot` (do not replay individual deltas)
- [ ] Ring buffer of the last N messages, for diagnosing gaps
- [ ] `prost` codegen from `spec/marketdata.proto` via `build.rs`
- [ ] Test: a subscriber that drops and reconnects recovers with no gap
- [ ] Test: a slow subscriber does not stall the engine — decide the policy (drop them,
      or buffer to a limit then drop) and write it down

## Done when

A CLI subscriber renders a live depth ladder; killing and restarting it recovers via
snapshot with no gap in `feed_seq`.
