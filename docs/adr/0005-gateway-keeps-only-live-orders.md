# ADR 0005: The gateway keeps a full record only for live orders

**Status:** accepted, 2026-11-12. Built in PR #34; released as `v0.3.0`.
Changes how `gateway/src/orders.rs` (the order tracker) holds the business day's orders.

## Context

### What was seen

The live server (a `t4g.small`, 2 GB) ran `v0.2.0` with the simulator at `SIM_ACTIVITY=0.2`.
Ten hours into the business day, measured per process (`memory.stat` of each container):

| | |
|---|---|
| Commands the exchange received since the 21:00 roll | 337,819 |
| of which new orders | 173,342 |
| of which cancels | 164,477 |
| Gateway process memory | **234 MB** |
| Exchange database process memory | 8 MB, plus 240 MB of file cache |

Two readings of those numbers matter:

- **The gateway grows with the day's traffic.** 234 MB over 173,342 orders is about 1.35 KB
  an order. It only falls back at the 21:00 roll, and a running program often keeps freed
  memory for reuse, so the day's peak is what the server must hold.
- **The database is not the problem.** Its own process holds 8 MB. The other 240 MB is file
  cache: Linux keeping recently read parts of its files in spare memory, which it hands back
  the moment anything else needs it. (An earlier reading counted that cache as use. It is
  not memory pressure.)

At activity 1 the simulator sends several times as many orders, so the gateway would reach
roughly 0.7 to 1.2 GB by the evening: too close to 2 GB to run safely.

### Why the gateway kept every order

For each order it accepts, the gateway's order tracker keeps a record: who sent it, under
which `ClOrdID`, the symbol and side, and the running totals (`CumQty`, `LeavesQty`,
`AvgPx`) every execution report carries. It also kept two lookup sets: `ClOrdID` to order,
for cancels, and every `ClOrdID` used, for the duplicate check.

Since milestone 2 the record stayed after the order finished, until the day's roll. A late
cancel for a finished order could then be answered precisely: "too late", with the order's
final status, rather than "unknown order".

### Why there are so many orders

95% of orders were cancelled. The simulator's market makers quote both sides of ten books
and replace their quotes each time their estimate of fair value moves, so nearly every order
lives a few seconds and never trades. The tracker kept a full record of each one all day.

## Options

1. **A bigger server** (`t4g.medium`, 4 GB). About $12 a month more, two minutes of
   downtime, no code. Pays for room instead of removing the cause, and the cause still
   scales with traffic.
2. **Keep finished orders in a database instead of memory.** Disk is cheaper than memory, but
   it puts a database write on almost every command in the gateway's single-threaded loop
   (milliseconds against microseconds), and creates a second record of what the journal
   already records. After a crash the two can disagree, which is exactly what the
   journal-only design ("the matching engine has no database") avoids. And nothing reads
   these records: the journal (archived to S3), the broker's own database and the public
   trade history already hold every order.
3. **Forget finished orders entirely,** keeping only live records and the day's used
   `ClOrdID`s. Smallest, but a late cancel would get "unknown order" instead of "too late":
   still valid FIX, but less precise than today.
4. **Keep a full record only while an order is live; when it finishes, keep a small entry
   (its order id and how it ended) under its `ClOrdID`.** Same FIX answers as today, with
   memory per finished order cut from about 1.35 KB to an estimated 0.1 KB.
5. **Calmer market makers** that re-quote less. Cuts the number of orders itself, and with
   it the journal, disk and CPU. A simulator change, worth doing, but it leaves the gateway
   vulnerable to any client that sends many short-lived orders.
6. **Trim the FIX messages kept for re-sending,** or reset the simulator's session hourly.
   Addresses a different store, which the measurement showed was small.
7. **Two servers,** the exchange on its own (the documented next step). About $19 a month
   more; moves the problem rather than fixing it.

## Decision

Option 4.

- **It removes the cause.** The gateway's memory follows the book (orders that can still
  trade, a few hundred at a time) plus a small entry per `ClOrdID` used today, instead of a
  full record per order today.
- **Nothing observable changes.** Every FIX answer is the same, including "too late" with the
  right status (filled, cancelled or expired); a `ClOrdID` stays spent for the day.
- **No new moving parts.** No database write in the hot path, no second source of truth.
  The tracker is still rebuilt purely from the journal, and the snapshot done-test
  (snapshot plus journal equals a full replay, byte for byte) still holds it to that.

Option 3 was rejected only because option 4 keeps the precise answer at a small cost.
Options 1 and 5 stay available: a bigger server if traffic outgrows this, calmer market
makers as a separate improvement (in `docs/BACKLOG.md`).

## Consequences

- One map per FIX session holds every `ClOrdID` used today, each **live** (the full record is
  in the tracker), **finished** (order id and how it ended), or **spent** (a rejected order
  or a cancel request). It replaces the two lookup sets.
- Snapshots carry a `finished` list. It is optional when read, so snapshots written before
  this change still load; finished orders in them become small entries.
- Memory still grows with the day's traffic, but by a small entry per order rather than a
  full record, and the roll still clears it.
- **To confirm after release:** the gateway's memory on the live server at the same time of
  day, against the 234 MB above. Then a day at `SIM_ACTIVITY=1`, measured before the roll.
  If memory is still tight, option 1 or 5.
