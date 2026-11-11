# matching-engine — Milestone 1

**The market itself.** Holds every resting order and decides who trades with whom.
No network, no database, no FIX. Driven by a CLI.

Status: **not started**

## Inputs / outputs

| | |
|---|---|
| **In** | `Command` — `NewOrder`, `Cancel`. One at a time, single-threaded, ordered. |
| **Out** | `Event` — `Accepted`, `Rejected`, `Trade`, `Canceled`, `BookDelta`. Emitted in the order they occur, one command producing zero or more. |
| **Owns** | The book (RAM) and the journal (append-only file). Nothing else. |
| **Knows nothing about** | networks, FIX, protobuf, SQL, accounts, money beyond integer cents. |

The event stream forks downstream: `Trade`/`Accepted`/`Rejected` become private execution
reports at the gateway; `BookDelta`/`Trade` become the public feed at md-publisher. The
engine does not know or care — it emits both and lets the layers above route them.

## Checklist

### 1. Types and invariants
- [ ] `PriceCents(i64)` and `Qty(i64)` as newtypes, not bare integers — they must not be
      mixable. This is where "no floats" becomes structurally enforced rather than a rule.
- [ ] `Side`, `OrderType` (Limit/Market), `TimeInForce` (Day/GTC/IOC/FOK)
- [ ] `OrderId(u64)` — monotonic, assigned by the engine, never reused
- [ ] `RestingOrder { order_id, client_order_id, participant_id, side, price, remaining, tif, arrival_seq }`
- [ ] No `f64` anywhere in the crate. Grep for it in CI if you want to be sure.

### 2. The book
- [ ] `asks: BTreeMap<PriceCents, VecDeque<RestingOrder>>` — ascending, best = first
- [ ] `bids: BTreeMap<Reverse<PriceCents>, VecDeque<RestingOrder>>` — so best is also first
- [ ] `best_bid()`, `best_ask()`, `spread()`
- [ ] `HashMap<OrderId, (Side, PriceCents)>` so cancel is O(1) instead of scanning
- [ ] Remove a price level when its queue empties — an empty level must not linger

### 3. Matching
- [ ] Limit order crosses while the opposing best price is acceptable **and** quantity remains
- [ ] One `Trade` per counterparty — a 100-share order hitting three resting orders
      produces three trades, not one
- [ ] Partial fills: decrement `remaining` on both sides, remove when zero
- [ ] Market order: walk until filled or the book is exhausted (no price limit)
- [ ] `IOC`: match what you can, discard the remainder, never rest
- [ ] `FOK`: check the full quantity is available **before** executing anything, else reject
- [ ] `Day`/`GTC`: rest the remainder
- [ ] Self-trade prevention — decide the policy and write it down (cancel resting? cancel
      incoming? decrement both?). Real venues differ; pick one and be explicit.

### 4. Cancel
- [ ] By `OrderId`, O(1) via the index
- [ ] Reject unknown ids and already-terminal orders with a reason, never silently

### 5. Journal
- [ ] Append every inbound command with a sequence number, **before** applying it
- [ ] `replay(path) -> Engine` rebuilds from an empty book
- [ ] Monotonic counters (`OrderId`, trade id) recovered from replay, not restarted —
      reissuing an id after a restart would be a correctness disaster downstream

### 6. CLI
- [ ] Submit orders, cancel, print the book as a depth ladder, print the trade tape
- [ ] Load a scripted scenario from a file, so tests and demos are reproducible

### 7. Tests
- [ ] Price-time priority: same price, earlier order fills first
- [ ] Walking the book: one order, several counterparties, correct fill sequence
- [ ] FOK rejects rather than partially filling
- [ ] IOC leaves nothing resting
- [ ] **Property:** replaying the journal reproduces a byte-identical book
- [ ] **Property:** no order ever fills more than its quantity
- [ ] **Property:** the book never crosses — `best_bid < best_ask` after every command
- [ ] Benchmark: p50/p99/p99.9 match latency, and orders/sec

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
