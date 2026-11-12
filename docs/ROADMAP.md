# Roadmap

Where the trading platform stands and where it is going: what each milestone built and the
test that proved it, what comes next, and where each service's own checklist lives. The
overview is in the [README](../README.md).

## Built so far

The MVP, milestones 0 to 8, is complete. Each milestone had a concrete test that proves it;
the full plan is in [PLAN.md](PLAN.md).

| | Milestone | Proved by |
|---|---|---|
| M1 | Matching engine | replaying the journal reproduces a byte-identical book |
| M2 | FIX 4.4 | QuickFIX/Go trades through the book, survives a `kill -9` of the gateway, and recovers a missed fill by resend |
| M3 | Market data | a property test: a subscriber joining at any point rebuilds the engine's exact book from the feed alone |
| M4 | Simulated market | thousands of orders with zero rejects and zero feed gaps; books one-sided for 9 of 721 seconds, market makers within their inventory limits |
| M5 | Broker ledger | 1,000 random fills match an independent tally to the cent; the database refuses an unbalanced entry |
| M6 | Order management | a fill that happened while the broker was killed was recovered on restart and booked to the cent |
| M7 | Market data service | a recorded feed replayed into candles that match an independent tally; killed mid-stream with no gap or double bar |
| M8 | Web client | "Buy 100" in the browser fills in the blotter while the book moves and holdings and P&L update |

<details>
<summary>What each milestone built, in more detail</summary>

**Milestone 8, the web client: complete.** The whole MVP runs in a browser with `pnpm dev`.
A Vite + React client signs in, and joins the two planes itself: prices, depth, candles and
time and sales from market-data (live over WebSocket), account, positions and orders from
the backend. Pick a symbol, star it, watch the book and chart move, place a market or limit
order from the ticket or by clicking a price in the book, confirm it, and see it fill in
the blotter with a toast while holdings and P&L update. Three styles (Pro, Active, Calm),
each in light and dark, share every container and differ only in tokens, layout and a few
view variants; layouts are data, ready for a drag-and-drop editor.

**Milestone 7, the broker's market data: complete.** Its own service and its own database.
It follows the exchange's feed with gap detection, stores every trade once, and rolls them
into 1-minute to 1-day candles (days on the venue's business day) by recomputing buckets,
so late ticks land correctly and restarts never double a bar. Browsers get live books
(conflated) and trades over WebSocket, and a slow browser is cut off rather than allowed
to stall ingest. Tested by replaying a recorded feed against an independent tally and by
killing it mid-stream.

**Milestone 6, the broker's OMS: complete.** An order now goes end to end: `curl` →
pre-trade risk in one transaction with the order write → the broker's own TypeScript FIX
initiator → Alpha Exchange → execution reports → the ledger. Every bad order is refused for
its own named reason. The FIX session never resets its numbers: a fill that happened while
the broker was `kill -9`'d was recovered by resend on restart and booked to the cent.
Orders are committed before they are sent, and recorded as sent in the same transaction as
their FIX sequence number, so a crash at any point loses nothing.

**Milestone 5, the broker's ledger: complete.** Double-entry books in Postgres, where the
rules cannot be bypassed: every entry balances per asset (checked at commit), shares can
never land in a cash account, and history is append-only. A fill books one entry with
three balanced pairs; positions and cash are only ever derived by summing lines; a settle
job moves shares from unsettled to settled; reconciliation checks the books against an
independent tally of fills. A test posts 1,000 random fills and matches an in-memory tally
to the cent.

**Milestone 4, simulated participants: complete.** The market is alive. A TypeScript
simulator, sharing no code with the exchange, logs on over its own FIX 4.4 initiator and
reads the public feed: market makers quote ten books around a hidden fair value (geometric
Brownian motion with news jumps), skew to shed inventory and pull quotes on jumps; noise,
momentum and mean-reversion traders take liquidity. Behaviour runs against the real
exchange, with an independent recorder on the feed, found and fixed books going one-sided
and market makers overshooting their inventory limits. Zero rejects and zero feed gaps
across thousands of orders.

**Milestone 3, market data: complete.** The public plane. Every book change and trade goes
out over WebSocket as protobuf, per the published `marketdata.proto`, with no field that
could identify a participant. Each message carries a venue-wide `feed_seq` and a
per-symbol `symbol_seq` (ADR 0001); a subscriber that sees a gap asks for a fresh
snapshot. Slow subscribers are disconnected rather than allowed to stall the feed. The
feed is rebuilt from the journal on restart, so its sequence numbers survive a `kill -9`.
A property test drives random order flow through the real engine and checks that a
subscriber joining at any point rebuilds the engine's exact book from the feed alone. 106
tests across the exchange.

**Milestone 2, FIX 4.4: complete.** Alpha Exchange speaks FIX over TCP. `fix-core` is a
hand-written codec, data dictionary and session state machine (logon, heartbeats, sequence
numbers, gap detection, resend); the `gateway` validates every order against the venue's
rules before the engine sees it and sends each side of a trade only its own execution
report. Sequence numbers live in the exchange's own Postgres and survive restarts.
Conformance-tested against **QuickFIX/Go**, which trades through the book, survives the
gateway being SIGKILLed, and recovers a missed fill by resend.

</details>

## What's next

The post-MVP roadmap is in `PLAN.md` Part 8, led by the post-trade plane (clearing, custody,
and settlement on a real T+1 clock). Smaller follow-ups and the layout editor are in
[BACKLOG.md](BACKLOG.md).

## Working on it

Each service carries its own **`TODO.md`**: a checklist plus the inputs and outputs it is
responsible for. Start there rather than from `PLAN.md`, which is the roadmap rather than
the working document.

| Milestone | Service | Checklist |
|---|---|---|
| M1 | matching engine | [`exchange-alpha/crates/matching-engine/TODO.md`](../exchange-alpha/crates/matching-engine/TODO.md) |
| M2 | FIX codec + session | [`exchange-alpha/crates/fix-core/TODO.md`](../exchange-alpha/crates/fix-core/TODO.md) |
| M2 | exchange gateway | [`exchange-alpha/crates/gateway/TODO.md`](../exchange-alpha/crates/gateway/TODO.md) |
| M3 | market data feed | [`exchange-alpha/crates/md-publisher/TODO.md`](../exchange-alpha/crates/md-publisher/TODO.md) |
| M4 | simulated participants | [`participants/simulator/TODO.md`](../participants/simulator/TODO.md) |
| M5–M6 | broker backend | [`broker/backend/TODO.md`](../broker/backend/TODO.md) |
| M7 | broker market data | [`broker/market-data/TODO.md`](../broker/market-data/TODO.md) |
| M8 | client | [`broker/web/TODO.md`](../broker/web/TODO.md) |

Conventions that apply everywhere are in [`docs/DECISIONS.md`](DECISIONS.md); the
short version is in [`CLAUDE.md`](../CLAUDE.md).
