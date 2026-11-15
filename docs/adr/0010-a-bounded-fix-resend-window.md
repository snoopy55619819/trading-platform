# ADR 0010: Alpha keeps a bounded FIX resend window

**Status:** accepted, 2026-11-15. Built in `fix-core` (`Session`) and the gateway; published
in Alpha's spec 1.2.0 (`listings.json`, `venue.order_entry.resend_window_messages`). The
memory side of ADR 0009's decision 2.

## Context

ADR 0009 found the gateway holding about 790 MB at `SIM_ACTIVITY=2` (249 MB resident, 538 MB
swapped out), against 37 MB measured in ADR 0005, and the exchange's database at 613 MB,
almost all of it `fix_outbound`: 264,000 rows 3.6 hours after the daily roll.

The cause is one line in `fix-core`'s session: every message the exchange sends on a session
was kept, in memory and in `fix_outbound`, for the life of the session, in case the client
asks for it again. The simulator's session sends about 3 million messages a day at activity
2 (execution reports for 1.5 million orders and their cancels), and is only reset at the
daily roll. So the store grew all day, to gigabytes by the evening, and doubled with
activity. Clearing it at the roll freed the memory inside the process, but the allocator
kept it, so the gateway's footprint never came back down and the idle part went to swap.

What the clients actually need from resend:

- **The simulator** resets its sequence numbers on every logon. It can never ask for a
  message from before its current connection, and over one TCP connection a gap is rare: a
  window of seconds would do.
- **The broker** never resets, and recovers fills it missed while it was down by resend
  (milestone 6's done-test). But its session carries only its own customers' orders: a few
  hundred messages a day.

## Options

1. **Keep everything** (as was). Correct for any client, and grows without bound.
2. **Keep everything, but only on disk.** Fixes memory, not the database, and a resend reads
   from Postgres.
3. **Don't keep anything for sessions that reset on logon.** Fits the simulator, but needs a
   per-client setting and still keeps everything for the rest.
4. **A bounded window for every session:** keep each session's latest N messages; a resend
   of anything older is answered with a `SequenceReset-GapFill`, and the client recovers
   those orders' state with an `OrderStatusRequest`. Published in the venue's spec, so
   clients know the limit.

## Decision

Option 4, with N = 50,000 messages.

- **50,000** is about 20 minutes of the simulator's session at activity 2 (far more than it
  ever needs) and weeks of the broker's, so the broker's crash recovery is unchanged in
  practice.
- **Trimmed in batches:** the store is cut back to the window when it has grown 5,000 past
  it, so trimming is not done on every message. The persistence layer is told the cut
  (`Changes::forget_below`) and deletes those rows in the same transaction as the new ones.
- **Gap-filling what is no longer kept needed no new code:** a resend already gap-fills any
  sequence number it has nothing stored for.
- **It is part of Alpha's published spec** (1.2.0, additive): real venues limit their
  resend windows too, and a client should know where the edge is.
- `SessionConfig::resend_window` is `None` (keep everything) unless set, so other users of
  `fix-core` and its tests keep the old behaviour.

## Consequences

- **The gateway's memory is bounded by the window, not by the day's traffic:** about 55,000
  messages of 300 to 400 bytes per busy session, around 20 MB, instead of gigabytes by
  evening. `fix_outbound` holds at most about 55,000 rows per session.
- **A client that is away longer than its window loses resend for the oldest messages,** and
  must ask for order status instead. For the broker that would take weeks of downtime at
  today's volume; it is noted in its plan rather than handled.
- **Raising simulator activity no longer grows the gateway** through this path. ADR 0009's
  decision 2 can be revisited once this is live and measured.
- Measured once released: the gateway's memory and `fix_outbound`'s size, as in ADR 0009.
