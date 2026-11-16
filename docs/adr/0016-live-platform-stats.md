# ADR 0016: Live platform stats, published by whoever owns them

**Status:** accepted, 2026-11-16. Built in three steps: the exchange's stats on its feed
(spec 1.4.0), then market-data and the backend's own, then the web app's live strip and the
"How it works" guide.

## Context

The platform now runs at about 300 transactions a second, working towards 1,000 (ADR 0012),
and the web app shows none of it. A visitor sees prices move but not the scale behind them:
how many orders and cancels the exchange handles, how many trades, how fast it answers, how
many messages fan out. Showing that is the point of the scaling work, and part of the
onboarding the guide started (ADR 0007).

Constraints:

- **Each company reports its own numbers.** The broker may know what the exchange publishes
  and nothing else (`CLAUDE.md`): the web app cannot ask the exchange's gateway, which is not
  public and has no HTTP at all.
- **Aggregate and anonymous.** Nothing may tell one participant's activity from another's
  (the simulator's share of the market, say).
- **Cheap.** Numbers that change hundreds of times a second must not cost a message per
  change, per viewer.

## Options

1. **Each owner counts and publishes once a second:** the exchange as a new message on its
   public market data feed, market-data and the backend as their own; market-data pushes all
   of it to browsers on the WebSocket they already have open.
2. **A `/stats` endpoint per service, polled by the browser.** Fine for the broker's
   services, but the exchange has no public HTTP, and its numbers are the interesting ones.
3. **Prometheus and Grafana.** Right for operating the server; heavy for a 2 GB machine
   (two more services), and a separate site, not part of the app.
4. **Counting from the databases** (trades a second in Postgres). Sees trades only, and
   loads the database.

## Decision

Option 1.

### What is tracked

Rates are over the last second. "Today" is since the business day began (21:00 UTC).

**The exchange** (`VenueStats` on the feed, spec 1.4.0, once a second to every connection,
like a heartbeat; it takes no sequence number):

| Field | What it counts |
|---|---|
| `transactions_per_sec` | new orders and cancel requests the exchange accepted and journaled |
| `new_orders_per_sec`, `cancels_per_sec` | the two halves of that |
| `rejects_per_sec` | orders and cancels refused before reaching the book (bad price, duplicate id, ...) |
| `trades_per_sec`, `shares_per_sec`, `notional_cents_per_sec` | matches, shares traded, their value |
| `fix_in_per_sec`, `fix_out_per_sec` | FIX messages received and sent, all sessions together |
| `feed_messages_per_sec` | book changes and trade prints published on this feed |
| `answer_p50_us`, `answer_p99_us` | how long an order or cancel takes inside the exchange: from the gateway taking it to its reply going out, after the session save (ADR 0013) |
| `open_orders` | orders resting on the books now |
| `sessions` | FIX sessions logged on now |
| `transactions_today`, `trades_today` | totals since the roll, from the journal and the trade numbers, so a restart does not lose them |

**market-data** (its own, step 2): browsers connected; feed messages received a second; live
messages sent to browsers a second; trades stored a second and today; feed gaps today.

**The backend** (its own, step 2): API requests a second; customer orders placed today; open
accounts.

### How it moves

- **Counted live, published once a second.** Each owner adds to in-memory counters as
  traffic happens and turns them into per-second figures on a one-second timer. Never one
  message per event: at 300 a second that would be 300 messages a second to every viewer, for
  numbers no one can read that fast.
- **The exchange's** go on its feed, which market-data already reads. Consumers that do not
  know the message ignore it (the simulator does), so the change is additive.
- **market-data** joins the exchange's with its own and the backend's, keeps the last five
  minutes in memory for small trend lines, pushes the result once a second on `/live`, and
  serves `GET /stats` for a page's first view.
- **The backend's** stay with the backend: services do not call each other for this. Its
  `GET /status`, which the web app already polls, gains them, and the web app joins the two,
  as it already joins orders and prices.

### In the web app

- A compact strip in the header: transactions a second, trades a second, answer time.
- In the "How it works" guide, each arrow of the flow diagram shows its live rate.
- A panel with every number, today's totals, a five-minute trend each, and one line saying
  what each one means.

## Consequences

- **Spec 1.4.0** adds `VenueStats` to `marketdata.proto`; every consumer vendors it. Nothing
  in it identifies a participant: only totals across all sessions.
- **The answer time is the exchange's own view.** The full round trip a client sees (network
  and its own event loop too) can only be measured by the client; the simulator does, for
  itself.
- **Per-second figures are as of the last second,** so they jump; the web app may smooth
  them for display, and keeps the trend lines for the shape.
- **Nothing is stored** beyond five minutes in memory. A history of these numbers is the
  backlog's observability item (Prometheus), which can read the same counters.
