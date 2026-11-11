# ADR 0001: A per-symbol sequence number on the market data feed

**Status:** accepted, 2026-11-11 (milestone 3). Changes `docs/DECISIONS.md` §6.
**Spec:** Alpha Exchange spec 1.1.0, `marketdata.proto`.

## Context

The convention was one sequence number, `feed_seq`, per venue, gapless, and "a subscriber
that sees a gap has lost data and must recover".

The feed also lets a subscriber choose its symbols (`Subscribe { symbols }`). Those two
rules contradict each other. A subscriber watching only `CRUX` receives `feed_seq` 5, 9,
12, because 6, 7, 8, 10 and 11 were other symbols. It cannot tell those skips from real
loss, so either it raises a false alarm on every message or it ignores gaps entirely, and
the convention is worthless either way.

## Options

1. **Send every symbol to everyone**, so `feed_seq` really is gapless per connection. This
   is how a multicast feed such as Nasdaq ITCH works: one stream, filtered by the receiver.
   But then `Subscribe` and `Unsubscribe` mean nothing, and a web client watching one
   symbol pays for all of them.
2. **Make `feed_seq` per symbol.** One counter does the job, but `Heartbeat` has no symbol,
   so it could no longer carry a meaningful number, and changing what an existing field
   means is the most dangerous kind of spec change: old consumers would misread it
   silently.
3. **Add `symbol_seq`, one counter per symbol, alongside `feed_seq`.** Subscribers check
   `symbol_seq` for gaps. `feed_seq` stays venue-wide: it orders messages across symbols and
   lets a subscriber to everything check the whole stream.

## Decision

Option 3. It is the pattern CME's MDP 3.0 uses: a sequence number per packet stream plus a
per-instrument `RptSeq`. It is purely additive (new field numbers, nothing renamed or
reinterpreted), so `buf breaking` passes and the version goes to 1.1.0 rather than 2.0.0.

The rules, now in the spec itself:

- Each `BookDelta` and `TradePrint` takes the next `feed_seq` **and** the next `symbol_seq`
  for its symbol.
- `Snapshot` and `Heartbeat` take neither. They carry the latest values already used, so a
  snapshot means "the book as of these numbers" and the next message for that symbol has
  `symbol_seq + 1`.
- A skip in `symbol_seq` is lost data: send `ResyncRequest`, get a fresh `Snapshot`.

## Consequences

- Sequence numbers depend only on the journal. Because heartbeats and snapshots take none,
  replaying the journal on restart rebuilds both counters exactly, so the feed continues
  across a crash without resetting, which is stronger than the old "while the venue is up".
- `ResyncRequest.last_good_feed_seq` keeps its name but is now diagnostic only: the
  exchange logs it against the messages it still holds.
- The broker's `market-data` service must check `symbol_seq` when it is built (M7). It
  re-synced its vendored copy of the spec in the same change, so `spec:check` passes.
