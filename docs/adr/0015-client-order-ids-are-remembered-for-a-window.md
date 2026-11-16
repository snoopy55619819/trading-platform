# ADR 0015: Alpha remembers live orders' ids and each session's latest million others

**Status:** accepted, 2026-11-16. Built in the gateway (`orders.rs`); published in Alpha's spec
1.3.0 (`venue.order_entry.client_order_id_window`). Stage 4 of `docs/SCALE-PLAN.md` (ADR
0012). Changes the rule ADR 0005 and ADR 0011 kept: "a `ClOrdID` may be used once a business
day".

## Context

To reject a reused `ClOrdID` for the whole business day, the gateway remembers every id each
session uses until the 21:00 roll: every new order's, and every cancel request's, since a
cancel carries its own `ClOrdID` too. So it keeps one entry per transaction. ADR 0011 made
each entry small, but the count is the problem:

- **Measured** (load test, 2026-11-16): 992,000 ids took the gateway to 168 MB, about 70 to
  150 bytes an id with the hash table's growth and the allocator (the live server's evening
  peak, 150 MB for 1.94 million, is the low end).
- **At the target** that is 43 million ids a day at 500 transactions a second, and 86 million
  at 1,000: about 3 to 6 GB, and 6 to 12 GB. The server has 2 GB in all.

What clients get from the day-long memory: a duplicate `ClOrdID` is caught all day, and a
cancel that arrives after its order finished is answered "too late" with how the order
ended, rather than "unknown order". Both matter in the seconds after an order finishes;
after hours they almost never happen. Our clients never reuse an id: the simulator's ids
carry a per-run prefix, the broker's are ULIDs.

## Options

1. **Keep every id all day** (as built). Needs gigabytes at the target.
2. **Check live orders only** (Cboe US equities, CME iLink 3; ADR 0011). Memory follows the
   book, but every late cancel becomes "unknown order", and a finished order's id can be
   reused at once.
3. **Require increasing ids per session** (Nasdaq OUCH). One number a session, day-long
   protection, but every client must change how it numbers orders, FIX itself does not ask
   for it, and late cancels still become "unknown order".
4. **Live orders, plus a window of the latest finished ones:** an id is rejected while its
   order is live, and while it is among the session's latest N finished, rejected or cancel
   ids. Bounded memory, the same answers as today for anything recent, and no client change.
   The same idea as the resend window (ADR 0010).

## Decision

Option 4, with N = 1,000,000 per session.

- **A live order's id is always remembered**, however long it rests.
- **Every other id is remembered while it is among its session's latest 1,000,000** finished
  orders, rejected orders and cancel requests; then forgotten, oldest first. A duplicate
  inside the window is rejected as before (`OrdRejReason` 6, `CxlRejReason` 6); a late cancel
  inside it is answered "too late" with the order's status, as before.
- **Counted, not timed:** the window is the latest million, not the last so many minutes,
  so a replay of the journal rebuilds exactly the same window (the journal has no clock).
  At 1,000 transactions a second it covers about 17 minutes; at today's rate, about half a
  day; for the broker's session, years.
- **Each id enters the window once,** when it is done with: an order when it finishes (not
  when it is first seen, since it is live in between), a rejected order when it is rejected,
  a cancel request when it is received. Each session keeps the order they arrived in, and a
  snapshot writes them in that order, so a restart forgets the same ones next.
- **Published** in spec 1.3.0, additive: `client_order_id_window`, with what a client sees
  for an id past it.
- At the 21:00 roll the window empties, as the day's ids did before.

## Consequences

- **The gateway's memory for ids is bounded** by the window, whatever the rate, instead of
  growing all day. Measured with the load test at about 5,000 transactions a second: the
  gateway reached 190 MB by 1.34 million ids and was still 190 MB at 1.72 million; before,
  it grew with every id (168 MB at 992,000, on course for gigabytes by evening at the target).
- **A cancel for an order that finished more than a million ids ago** gets "unknown order"
  (`CxlRejReason` 1) instead of "too late" (0). Either way the client learns the order is
  gone; it no longer learns how it ended (an `OrderStatusRequest` would tell it, still on the
  backlog).
- **A client could reuse an id after the window.** Alpha would accept it as a new order. No
  client of ours does, and FIX asks clients not to.
- `docs/DECISIONS.md` (§3 and the roll) and the gateway's TODO now state the window instead of
  "per business date".
