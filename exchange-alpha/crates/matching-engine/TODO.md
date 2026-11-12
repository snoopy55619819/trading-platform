# matching-engine — Milestone 1

**The market itself.** Holds every resting order and decides who trades with whom.
No network, no database, no FIX. Driven by a CLI.

Status: **done**

```
cargo run -p matching-engine -- crates/matching-engine/scenarios/demo.txt   # walkthrough
cargo test -p matching-engine                                              # 53 tests
cargo bench -p matching-engine                                             # latency
```

## Inputs / outputs

| | |
|---|---|
| **In** | `Command` — `NewOrder`, `Cancel`, `EndOfDay`. One at a time, single-threaded, ordered. |
| **Out** | `Event` — `Accepted`, `Rejected`, `Trade`, `Canceled`, `BookDelta`. Emitted in the order they occur, one command producing zero or more. |
| **Owns** | The book (RAM) and the journal (append-only file). Nothing else. |
| **Knows nothing about** | networks, FIX, protobuf, SQL, accounts, money beyond integer cents. |

The event stream forks downstream: `Trade`/`Accepted`/`Rejected` become private execution
reports at the gateway; `BookDelta`/`Trade` become the public feed at md-publisher. The
engine does not know or care — it emits both and lets the layers above route them.

## Checklist

### 1. Types and invariants
- [x] `PriceCents(i64)` and `Qty(i64)` as newtypes, not bare integers — they must not be
      mixable. This is where "no floats" becomes structurally enforced rather than a rule.
- [x] `Side`, `OrderType` (Limit/Market), `TimeInForce` (Day/GTC/IOC/FOK)
- [x] `OrderId(u64)` — monotonic, assigned by the engine, never reused
- [x] `RestingOrder { order_id, client_order_id, participant_id, side, price, remaining, tif, arrival_seq }`
- [x] No `f64` anywhere in the crate. Grep for it in CI if you want to be sure.

### 2. The book
- [x] `asks: BTreeMap<PriceCents, VecDeque<RestingOrder>>` — ascending, best = first
- [x] `bids: BTreeMap<PriceCents, Level>`, read from the high end. (Changed from the
      `Reverse` key originally planned: one key type on both sides means a price lookup is
      the same code for bids and asks, and only "which end is best" differs.)
- [x] `best_bid()`, `best_ask()`, `spread()`
- [x] `HashMap<OrderId, Location>` so cancel goes straight to the level instead of scanning
      every book. Removing from within the level is still a scan of that level's queue;
      fine while levels are short, and an intrusive linked list is the fix if they are not.
- [x] Remove a price level when its queue empties — an empty level must not linger

### 3. Matching
- [x] Limit order crosses while the opposing best price is acceptable **and** quantity remains
- [x] One `Trade` per counterparty — a 100-share order hitting three resting orders
      produces three trades, not one
- [x] Partial fills: decrement `remaining` on both sides, remove when zero
- [x] Market order: walk until filled or the book is exhausted (no price limit)
- [x] `IOC`: match what you can, discard the remainder, never rest
- [x] `FOK`: check the full quantity is available **before** executing anything, else reject
- [x] `Day`/`GTC`: rest the remainder
- [x] Self-trade prevention. **Policy: cancel the incoming order's remainder**, leave the
      resting order alone. Trades with other participants ahead of it still happen. FOK's
      availability check stops at the taker's own order too, so it agrees with matching.

### 4. Cancel
- [x] By `OrderId`, O(1) via the index
- [x] Reject unknown ids and already-terminal orders with a reason, never silently

### 5. Journal
- [x] Append every inbound command with a sequence number, **before** applying it
- [x] `replay(path) -> Engine` rebuilds from an empty book
- [x] Monotonic counters (`OrderId`, trade id) recovered from replay, not restarted —
      reissuing an id after a restart would be a correctness disaster downstream

### 6. CLI
- [x] Submit orders, cancel, print the book as a depth ladder, print the trade tape
- [x] Load a scripted scenario from a file, so tests and demos are reproducible

### 7. Tests
- [x] Price-time priority: same price, earlier order fills first
- [x] Walking the book: one order, several counterparties, correct fill sequence
- [x] FOK rejects rather than partially filling
- [x] IOC leaves nothing resting
- [x] **Property:** replaying the journal reproduces a byte-identical book
- [x] **Property:** no order ever fills more than its quantity
- [x] **Property:** the book never crosses — `best_bid < best_ask` after every command
- [x] Benchmark: p50/p99/p99.9 match latency, and orders/sec

### 8. Daily roll (post-MVP, before deployment)

Without an end of day, `Day` orders never expired and the journal grew forever, so every
start replayed all of history. The plan, in steps across the exchange:

- [x] **Step 1. End of day.** `Command::EndOfDay { business_date }` expires every resting
      `Day` order (`CancelReason::Expired`); `Gtc` orders stay. Resting orders now carry
      their time in force. Journaled like any command, so replay reproduces the close.
      Tests in `tests/end_of_day.rs`, and the property tests now generate closes too.
- [x] **Step 2. Snapshot and restore.** `Engine::restore` rebuilds an engine from its
      snapshot (and refuses one that does not add up); a journal can continue an earlier
      one's numbering (`Journal::open_after`, `JournaledEngine::resume_observing`). The
      gateway's `recovery` module captures and restores the engine, the order tracker and
      the feed's numbering (`ExchangeState`); the feed's levels are rebuilt from the engine's
      book rather than stored twice. **Done-test** (`gateway/tests/snapshot.rs`): over random
      order flow with closes, a snapshot plus the next journal gives byte-identical state to
      a full replay, and so does the exchange that kept running. Checked by breaking the
      restore on purpose (dropping the feed numbering, then the used `ClOrdID`s): it fails.
- [x] **Step 3. The roll in the gateway.** At the business-date roll the gateway journals
      `EndOfDay`, sends `ExecType=C` (Expired) reports, and the order tracker forgets the
      day's finished orders and `ClOrdID`s (on the engine's `DayClosed` event, so replay does
      the same). Then it writes the snapshot and continues in the next day's journal
      (`gateway/src/days.rs`: `alpha-<date>.<first seq>.snapshot.json` and `.journal`). A
      start loads the newest snapshot, finishes a roll it was stopped in, or closes the day
      if it was down at the roll time. Tests in `gateway/tests/roll.rs`, including a crash
      between the close and the next day's snapshot.

## Done when

Replaying a recorded journal reproduces the book exactly, the property tests hold over
generated command sequences, and the benchmark prints latency percentiles.

## Notes for the implementation

- **`BTreeMap` ordering for bids.** You want "best first" on both sides. Wrapping the bid
  key in `std::cmp::Reverse` gives you that without a second code path in matching.
- **`VecDeque` per level** is the time-priority queue: `push_back` to rest, `pop_front` to
  match. That is FIFO, which *is* time priority.
- **The borrow checker will fight you** when you mutate the book while walking it. The
  usual shape is to collect the fills first, then apply them — or use `first_entry()` and
  operate on one level at a time. Don't reach for `RefCell` to escape this; the fight is
  telling you something about ordering.
- **Write the journal before applying**, not after. A crash between the two must leave a
  command that will be replayed, not one that was applied and lost.

## What was measured

`cargo bench` on an Apple M5 Pro, 1M commands against a book that grows to about 32,000 resting
orders. Each figure includes reading the clock (roughly 20 to 40 ns).

| | p50 | p99 | p99.9 | throughput |
|---|---|---|---|---|
| Engine alone | 209 ns | 750 ns | 1.3 µs | 4.3M commands/s |
| Engine + journal | 1.3 µs | 3.3 µs | 8.1 µs | 0.69M commands/s |

The journal costs about 1 µs per command, almost all of it the `write` system call behind
the per-command flush. That flush survives the process crashing, not the machine losing
power; surviving power loss needs an fsync, which is far slower, so batching fsyncs
("group commit") is a decision for the gateway at M2.

## Decisions to revisit later

- **DAY behaves like GTC.** There is no session clock yet, so nothing expires day orders.
  That arrives with the clock service post-MVP.
- **No ids in the journal.** Ids are recomputed by replay rather than stored, which is only
  sound because matching is deterministic. Anything that makes it non-deterministic (a
  clock read, a random choice, iterating a `HashMap`) breaks recovery. The property tests
  would catch it.
