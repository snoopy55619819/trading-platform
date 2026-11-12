# Trading Platform — Architecture & Build Plan

## Context

`trading-platform/` is empty. The goal is a **learning-first, resume-grade** simulation of the equities
trading lifecycle: a client places an order, it routes through broker → OMS → exchange matching engine,
fills, and lands in holdings backed by a real double-entry ledger. Nothing touches real market data or
real money.

Three constraints drive every decision:

1. **Segregated, independently-workable tasks** — each service has a hard contract boundary so it can
   be built, tested and run alone against stubs.
2. **A 24/7 living market** — synthetic participants trade continuously, so a solo user always sees a
   realistic book, tape and chart.
3. **Thin-but-correctly-bounded first** — minimal implementations, but the *contracts* are right from
   day one, so deepening later is additive rather than a rewrite.

**Decisions made:**

| Decision | Choice |
|---|---|
| Languages | **Rust** for the exchange, **TypeScript** for everything else |
| Protocol | Hand-rolled **FIX 4.4** subset, OMS ↔ exchange gateway, **in the MVP** |
| Contracts | **Fully defined up front** in milestone 0 |
| Database | **Postgres only** for v1 (ClickHouse migration is a later milestone) |
| Holdings | **Double-entry ledger from day one** — positions are *derived*, never incremented |
| Deployment | docker-compose locally; one server with Docker Compose in production, two servers split by company next (ADR 0003, `DEPLOYMENT.md`) |
| UI | Last MVP milestone; everything before it is driven by CLI/curl |

---

## Part 1 — The domain

### The parties in a real market

| # | Party | Real example | What it owns |
|---|-------|--------------|--------------|
| 1 | Trader | You | Intent to buy/sell |
| 2 | Broker-dealer | Schwab, IBKR | Client account, cash, custody, order routing |
| 3 | Exchange / venue | NYSE, Nasdaq | Central limit order book, matching, market data |
| 4 | Market makers | Citadel Securities | Continuous two-sided quotes = liquidity |
| 5 | Consolidated tape | UTP, CTA | Merges venues → the NBBO |
| 6 | Clearing house (CCP) | NSCC | **Novation** + multilateral **netting** |
| 7 | Depository (CSD) | DTC | Book-entry share ownership; moves shares at settlement |
| 8 | Settlement bank | Fed / commercial | The cash leg |
| 9 | Regulator | SEC, FINRA CAT | Audit trail, abuse detection |

v1 plays parties 1–4. Parties 5–9 arrive post-MVP.

### The single most important structural idea

Your researched chain was directionally right, but flattened one thing:

> **There are two independent data planes, not one pipeline.**
>
> - **Order plane** — authenticated, request/response, per-client, FIX-shaped.
>   `Client → Broker API → OMS → Exchange gateway → Matching engine`, execution reports back up.
> - **Market data plane** — public, broadcast, sequenced, fanned out to everyone.
>   `Matching engine → MD publisher → subscribers`.
>
> Your UI's "live price + order book" comes from the **second** plane. That data never travels back up
> the order path. A fill you caused reaches you twice, by two different routes, for two different
> reasons — privately as an execution report, publicly as an anonymous print on the tape.

Building these as genuinely separate systems is the highest-value architectural lesson here.

### Corollary

**An SOR with one venue is a no-op function.** Smart order routing only becomes real with ≥2 venues
whose books diverge. That's why the SOR is deliberately *out* of the MVP and stubbed — building it now
would teach nothing.

---

## Part 2 — v1 MVP scope

**8 services · 5 processes · 2 languages · 1 database.**

### In scope

**5 deployables · 2 languages · 2 databases.**

```
┌──────────── ALPHA EXCHANGE — one Rust binary, 4 crates ────────────┐
│   fix-core  ·  gateway (acceptor)  ·  matching-engine  ·  md-publisher │
└────────────────────────────────────────────────────────────────────┘
        ▲ FIX 4.4 / TCP                          │ WS: snapshot + deltas
        │                                        ├──────────────┐
        │                                        ▼              ▼
   ┌─────────────────────┐              ┌──────────────┐  ┌───────────┐
   │      backend        │              │ market-data  │  │ simulator │
   │  api · oms · ledger │              │     (TS)     │  │   (TS)    │
   │       · fix   (TS)  │              │ own database │  └─────┬─────┘
   └──────────┬──────────┘              └──────┬───────┘        │ FIX
              │ HTTP                           │ WS + REST      └──▶ exchange
              │                                │
              └───────────┐        ┌───────────┘
                          ▼        ▼
                       ┌──────────────┐
                       │     web      │   joins the two itself:
                       │  static SPA  │   positions from backend,
                       └──────────────┘   prices from market-data
```

### Explicitly out of scope for v1 (and why that's safe)

| Cut | Why | How v1 stays forward-compatible |
|---|---|---|
| Exchange Beta, SOR, consolidated tape | SOR is meaningless with one venue | `venue` field exists on every order/fill, always `"ALPHA"`. Adding Beta is data, not migration |
| Clearing, custodian, settlement bank | A whole plane, 4 services | Ledger posts fills to `CLIENT_SECURITIES_UNSETTLED`, and an **auto-settle job runs instantly**. v2 changes *when* that job fires, not the schema |
| `clock` service | Nothing to fast-forward yet | Arrives with settlement |
| Redpanda bus | Single consumers, and the only cross-process hops are FIX and WS | A bus earns its place when post-trade creates real fan-out |
| Redis | In-memory sessions are fine for one user | — |
| ClickHouse | One DB is simpler | `ticks`/`bars` tables designed to be portable; migrating later gives a *measurable* before/after |
| `refdata` as a service | ~3 tables | Seeded JSON in `contracts/` + Postgres tables; promote to a service later |

**The two decisions that prevent a rewrite:** the `venue` column, and settled/unsettled as *separate
ledger accounts* with an instant auto-settle job. Both cost nothing now and make the biggest future
additions purely additive.

---

## Part 3 — MVP service catalogue

Each entry: what it's for, what data it owns, what goes in and out.

---

### 3.1 `matching-engine` — **Rust** · in-memory + append-only journal

**Purpose.** *This is the actual market.* Holds every resting order and decides who trades with whom.

**Owns** — no database, deliberately. Real engines don't touch a DB in the hot path.
```rust
// per symbol
bids: BTreeMap<PriceTicks, VecDeque<RestingOrder>>   // descending
asks: BTreeMap<PriceTicks, VecDeque<RestingOrder>>   // ascending

RestingOrder { order_id, client_order_id, participant_id, side,
               price_ticks, qty, remaining_qty, tif, arrival_seq }

Journal: append-only file — every inbound command and every outbound event
```
State lives in RAM. Durability is the journal. **Recovery is replay** — restart, replay, get a
byte-identical book. That property is the best test in the whole project.

**In** `NewOrder` / `Cancel` / `Replace` · **Out** two forked streams:
- **private** → `ExecutionReport`, to the order's owner only
- **public** → `BookDelta` + `Trade`, to the market data plane

**Core rule — price-time priority.** Best price wins; within a price level, first-arrived wins (FIFO).
An aggressive order *walks the book*: consumes the best level, then the next, one fill per counterparty.

**v1 order types** limit, market, IOC, FOK · day/GTC. *Later:* stop, iceberg, post-only, midpoint.

---

### 3.2 `fix-core` + `fix-gateway` — **Rust** · Postgres (session state only)

**Purpose.** The door into the exchange. Authenticates sessions, guarantees no message is lost or
duplicated, and translates FIX into internal commands — so the engine never learns what a network is.

**Owns**
```sql
fix_sessions(session_id, sender_comp_id, target_comp_id,
             next_expected_in_seq, next_out_seq, last_heartbeat_at)
fix_outbound_store(session_id, msg_seq, raw_message)   -- for ResendRequest replay
```

**Session layer** `Logon(A)` · `Heartbeat(0)` · `TestRequest(1)` · `ResendRequest(2)` ·
`SequenceReset(4)` · `Logout(5)` · monotonic sequence numbers · gap fill · `BodyLength(9)` ·
`CheckSum(10)`

**Application layer** `NewOrderSingle(D)` · `ExecutionReport(8)` · `OrderCancelRequest(F)` ·
`OrderCancelReject(9)`

**Validates before the engine sees anything** tick size · lot size · price bands · symbol status ·
duplicate `ClOrdID`

**Why separate from the engine:** you can later add a REST or binary gateway without touching a line
of matching logic. That boundary pays for itself immediately.

---

### 3.3 `md-publisher` — **Rust**

**Purpose.** Broadcasts book changes to anyone listening. This is where the chart and depth ladder
actually come from.

**Owns** — in-memory: current snapshot per symbol, ring buffer of the last N published messages,
monotonic `feed_seq` per venue and `symbol_seq` per symbol (ADR 0001).

**In** `BookDelta` / `Trade` from the engine · **Out** `Snapshot`, `BookDelta`, `Trade`, `Heartbeat`
over WS. Every message is stamped with `feed_seq`, and deltas and prints with `symbol_seq`

**Core rule — snapshot + sequenced incrementals.** A subscriber seeing seq jump 41 → 43 *knows* it lost
42, and recovers by requesting a replay or fresh snapshot. This is why market data is a real protocol
and not "just a websocket".

---

### 3.4 `backend` / ledger module — **TS** · Postgres

**Purpose.** The broker's books. Every cent and every share accounted for twice. This is what actually
answers "what do I own, and what can I spend?"

**Owns**
```sql
ledger_accounts(account_id, owner_id, account_type, asset, normal_balance)
  account_type ∈ CLIENT_CASH
               | CLIENT_SECURITIES_UNSETTLED | CLIENT_SECURITIES_SETTLED
               | FEES_REVENUE | HOUSE_CASH | STREET_CONTRA
  asset        = 'CASH' | ticker          -- shares are denominated in shares, not cents

journal_entries(entry_id, ts, description, reference_type, reference_id)
journal_lines(line_id, entry_id, account_id, asset, debit, credit)
  -- CONSTRAINT: per entry, per asset, SUM(debit) = SUM(credit)

reconciliation_runs(run_id, run_ts, checks_passed, discrepancies_json)
```

**Positions and cash are derived from `journal_lines`, never stored as an incremented counter.** This
is the habit that makes the later clearing/settlement work tractable, and it's a strong resume detail
on its own.

A fill produces one entry with three balanced pairs: the cash leg, the fee leg, and the share leg
(`CLIENT_SECURITIES_UNSETTLED` against `STREET_CONTRA`). `STREET_CONTRA` becomes
`CLEARING_RECEIVABLE`/`PAYABLE` when the CCP arrives.

**Auto-settle job** — v1 moves `UNSETTLED → SETTLED` immediately. v2 fires the same job on
`SettlementDate` from the clock. Same code path, different trigger.

**In** `Fill` from the oms module · **Out** balances, positions and buying power — in-process calls, inside the caller's transaction

**Nightly recon** proves `Σdebits == Σcredits` per asset, and (post-MVP) that client positions match
the custodian.

---

### 3.5 `backend` / oms module — **TS** · Postgres · **FIX initiator**

**Purpose.** Decides whether you're *allowed* to place an order, then tracks it from birth to death.
The most business-logic-dense service in the system.

**Owns**
```sql
accounts(account_id, user_id, status, created_at)

orders(order_id, client_order_id, account_id, venue, symbol, side, order_type, tif,
       price_ticks, qty, filled_qty, avg_fill_price_ticks, status, created_at, updated_at)
  status ∈ PendingNew | New | PartiallyFilled | Filled
         | PendingCancel | Canceled | Rejected | Expired

order_events(event_id, order_id, seq, event_type, payload, ts)
  -- append-only; the orders row is a projection of this

risk_limits(account_id, max_order_value_cents, max_position_qty, max_orders_per_min)
outbox(id, topic, payload, created_at, published_at)
```

Note: **no `positions` table** — the ledger module owns that. Being in the same process,
the OMS reads it inside the same transaction as the order write, which is the entire
reason these are not separate services.

**Pre-trade risk checks** (all must pass before routing): buying power (from ledger) · position limit ·
price band / fat-finger guard · symbol not halted · tick size valid · lot size valid · duplicate
`ClOrdID`.

**Transactional outbox** — the order state change and the "fill event published" record commit in the
*same* Postgres transaction, so the DB and downstream consumers can never disagree.

**In** in-process calls from the api module · **Out** FIX `NewOrderSingle` to the exchange;
`Fill` events to the ledger

---

### 3.6 `market-data` — **TS** · its own database

**Purpose.** Owns the whole market data concern on the broker side: **live** fanout to
the client over WebSocket, and **history** — every tick persisted and rolled into candles.

Its own deployable and its own database, on technical grounds rather than organisational
ones: continuous write-heavy ingest, no transactional coupling to anything, and a columnar
store in its future. It sits on the anonymous public plane, so it needs none of the
backend's domain types and could be rewritten in another language unchanged.

**Owns**
```sql
ticks(ts, symbol, venue, event_type, price_ticks, size, feed_seq)
bars(bucket_ts, symbol, interval, open, high, low, close, volume, trade_count)
```
Bars rolled up from `ticks` on a schedule. Intervals: 1m, 5m, 1h, 1d.

**In** the md-publisher WS feed (a normal gap-detecting subscriber) · **Out** live prices
over WS to `web`, plus `GET /history?symbol=&interval=&from=&to=`

---

### 3.7 `simulator` — **TS**

**Purpose.** Makes the market look alive when nobody is using the app. Without this, v1 is an empty
book and a flat chart.

**In** the market data feed (agents watch the book like anyone else) · **Out** orders **through the
same FIX path a real client uses**

**No backdoor into the engine.** The simulator is just more FIX clients. That's exactly what makes it a
valid test of the whole system rather than a cheat — and it means the FIX gateway gets hammered
continuously from day one.

**Price process.** Each symbol has a hidden fair value on a geometric Brownian motion with per-symbol
drift and volatility, plus occasional jumps ("news"). This is what makes the chart look like a real
stock instead of noise around a flat line.

**Agents**
- **Market makers** — quote two-sided around fair value; spread widens with volatility;
  **inventory skew** (if long, shade quotes down to offload); pull quotes on large adverse moves.
- **Noise traders** — Poisson arrivals, random side, small market orders.
- **Momentum traders** — chase short-term moves; create trends.
- **Mean-reversion traders** — fade extremes; create pullbacks.
- **Diurnal multiplier** on volume and volatility, so there are quiet and busy hours even running 24/7.

*(Arbitrageur agents arrive with Exchange Beta.)*

---

### 3.8 `backend` / api module — **TS**

**Purpose.** The only thing the outside world talks to. Auth, plus reshaping internal data into
something a UI can render. Deliberately thin — no business logic.

**Owns** `users(user_id, email, password_hash)`; in-memory sessions and WS subscription registry.

**In** REST from `web` · **Out** in-process calls to the oms and ledger modules

---

### 3.9 `web` — **TS / React**

Minimal, last. Symbol picker · price chart and live bid/ask (from `market-data`) ·
holdings and blotter (from `backend`) · order ticket. It calls both services and joins
them client-side — position P&L is backend positions × market-data prices.

---

## Part 4 — One order, end to end (v1)

The clearest illustration of what each service is *for*. Trace "buy 100 AAPL at market":

| Step | Service | What happens |
|---|---|---|
| 1 | `backend` api | `POST /orders {AAPL, BUY, 100, MARKET}`. Authenticates, assigns `ClOrdID` |
| 2 | `backend` oms | Validates symbol/lot/tick against the security master. Reads buying power from the ledger module **in the same transaction** |
| 3 | `backend` oms | Writes `orders` + `order_events` **in that same transaction**, status `PendingNew`. No outbox needed — nothing crosses a process boundary |
| 4 | `backend` fix | FIX `NewOrderSingle(35=D)` over TCP |
| 5 | `fix-gateway` | Checks session sequence numbers, tick size, lot size, duplicate ClOrdID. Converts to an internal command |
| 6 | `matching-engine` | The aggressive buy **walks the ask side**, matching resting sellers in price-time order. Produces 2–3 `Trade`s |
| 7a | *private path* | `ExecutionReport(35=8, ExecType=F)` → gateway → backend. Sets `filled_qty=100`, `avg_price`, status `Filled`. Hands a `Fill` to the ledger module |
| 7b | *public path* | `BookDelta` + `Trade` → md-publisher → **market-data**, which persists it for the chart *and* fans it out over WS, where **everyone's** screen ticks |
| 8 | `backend` ledger | One journal entry, three balanced pairs: cash · fee · shares into `CLIENT_SECURITIES_UNSETTLED` |
| 9 | `backend` ledger | Auto-settle job moves `UNSETTLED → SETTLED`. *(In v2 this waits for T+1.)* |
| 10 | `web` | Holdings show 100 AAPL; blotter shows the fill; the chart already ticked at step 7b |

**Steps 7a and 7b are the whole architecture in two rows** — the same event reaching you privately as
your execution report and publicly as an anonymous print, by two completely separate paths.

---

## Part 5 — Domain rules that make this credible

Encode these in `contracts/` at milestone 0. Retrofitting them hurts.

- **Never use floats for money.** Prices are integer ticks; cash is integer minor units (cents).
- **Price-time priority.** Best price first; strict FIFO within a level.
- **Idempotency.** `ClOrdID` unique per session per day. A retried order must not double-execute.
- **Sequenced market data.** Every feed message carries a seq number; subscribers detect gaps and
  recover via snapshot + replay.
- **Settled vs unsettled** are separate ledger accounts from day one, even though v1 settles instantly.
- **Double-entry.** Positions and cash are *derived* from journal lines, never incremented in place.
- **Reconciliation.** A nightly job proving the books balance.

---

## Part 6 — Repo layout

Organised **by company**, and within the broker, **by deployable**.

```
trading-platform/
  exchange-alpha/              # Alpha Exchange (Rust) — one binary
    spec/                      #   PUBLISHED: fix44.xml, marketdata.proto, listings.json
    crates/                    #   private: fix-core, matching-engine, md-publisher, gateway
  broker/                      # the broker-dealer — three deployables, nothing shared
    backend/                   #   ONE process: api + oms + ledger + fix
      src/{api,oms,ledger,fix,domain}/  migrations/  scripts/  vendor/
    market-data/               #   live WS fanout + chart history; its OWN database
      src/  scripts/  vendor/
    web/                       #   static client bundle
    compose.yml
  participants/                # third-party trading firms
    simulator/                 #   a deployable, like any other
  participants/                # simulated third-party trading firms
  docs/                        # ADRs, sequence diagrams, glossary
```

**No workspace, no shared package, no shared database** between the three broker
deployables. Each installs its own dependencies and vendors its own copy of the exchange
spec **with its own sync script**, taking only the files it uses — `backend` needs
`fix44.xml`, `market-data` needs `marketdata.proto`, both need `listings.json`. That is what makes it true that
`market-data` could be rewritten in Go and nothing else would change.

**Where the boundaries are, and why.** The company boundary is real — two businesses, a
network between them, FIX as the contract. Inside the broker, `api`/`oms`/`ledger` are
*not* separate: they share a transaction, and splitting them would make a buying-power
check non-atomic in exchange for nothing. `market-data` is separate on technical grounds —
continuous write-heavy ingest, no transactional coupling, a columnar store in its future.

Cross-company interfaces are **published specs**, not shared files: the exchange publishes,
consumers vendor a copy, and `spec:check` fails when a copy falls behind. That drift is not
a repo defect — it is the integration work a real firm does.

## Part 7 — MVP milestones

Thin-but-correctly-bounded: minimal implementation, right contracts. Driven by CLI/curl until M8.
Each milestone is independently workable with a concrete done-test.

| # | Milestone | Size | Done when |
|---|---|---|---|
| **0** | **Foundations.** All protobuf definitions, the FIX 4.4 dictionary subset, refdata seed (~10 symbols), `DECISIONS.md`, docker-compose with Postgres, migration tooling, codegen for Rust + TS. | M | `docker compose up` starts Postgres; contracts generate cleanly in both languages |
| **1** | **Matching engine.** Order book, price-time priority, limit/market/IOC/FOK, append-only journal + replay. No network — CLI-driven. | L | Property test: replaying the journal reproduces a byte-identical book. Bench prints p50/p99 match latency |
| **2** | **FIX 4.4.** `fix-core` codec + session state machine (Rust), the gateway acceptor, and the TS initiator library. Two independent implementations sharing only a dictionary. | L | QuickFIX logs on, sends `NewOrderSingle`, receives `ExecutionReport`s. Kill mid-session → `ResendRequest` recovers the gap. TS initiator round-trips against the Rust acceptor |
| **3** | **Market data plane.** md-publisher: snapshot + sequenced incrementals over WS. CLI depth viewer with gap detection. | M | The CLI renders live depth; kill and restart it and it recovers via snapshot with no gap |
| **4** | **Simulator.** Fair value process + market-maker, noise, momentum and mean-reversion agents, all over FIX. | M | The book is alive 24/7 and the depth ladder looks like a real market |
| **5** | **Broker ledger.** Double-entry schema, balanced-entry constraint, derived positions/cash/buying power, auto-settle job, recon job. | M | Post 1,000 random fills; `Σdebits == Σcredits` per asset; derived positions match an independent tally |
| **6** | **OMS.** Accounts, order state machine, `order_events` audit trail, pre-trade risk (calling the ledger), transactional outbox, FIX initiator to the exchange, fills → ledger. | L | `curl` an order → risk-checked → FIX → filled → ledger updated → holdings correct. Bad orders rejected for the *right* reason |
| **7** | **Market data service.** Subscribe to the feed, fan out live prices over WS, persist ticks, roll up bars, serve `/history`. Gets its own database here. | S | Chart-ready OHLCV for any symbol over any window |
| **8** | **Broker API + UI.** Auth, REST + WS BFF, minimal React: symbol picker, chart, depth ladder, holdings, blotter, order ticket. | M | Click "buy 100" in the browser, watch the book move and holdings update |

Milestones 1 → 2 → 3 → 4 are a clean sequential chain on the Rust side. Milestone 5 has **no
dependency** on 1–4, so it's a good parallel track when you want a break from Rust.

---

## Part 8 — Post-MVP roadmap

Each is a self-contained project, in rough value order:

| Milestone | What it adds | Why it's worth it |
|---|---|---|
| **Exchange Beta + SOR + consolidated tape** | Second venue (same binary, different fees/agents), NBBO service, real routing: best price, sweep, split, re-route. Arbitrageur agents couple the books. The TS FIX initiator moves from OMS to SOR. | Makes three services meaningful instead of ceremonial |
| **Post-trade plane** | Clearing (novation + EOD multilateral netting), custodian (book-entry, DVP), settlement bank, `clock` for real T+1. Auto-settle becomes clock-driven; `STREET_CONTRA` becomes `CLEARING_RECEIVABLE`. | **The differentiator.** Plenty of side projects have a matching engine; almost none have a CCP |
| **Redpanda bus** | Replace direct connections where fan-out is now real (fills → ledger + clearing + surveillance). | Replay-driven state rebuild |
| **ClickHouse migration** | Move `ticks`/`bars` off Postgres. | A *measured* before/after beats "I used ClickHouse because it's fast" |
| **Observability** | OTel trace propagated end to end; Prometheus + Grafana; latency histograms. | One Jaeger trace spanning browser click → FIX → match → settlement |
| **Chaos + perf** | Kill each service mid-flight; assert no lost, duplicated or double-executed orders. Engine throughput benchmarks. | Where the FIX resend logic and the outbox prove their worth |
| **Surveillance** | Wash-trade, spoofing and layering detection — plus simulator agents that deliberately commit them. | Distinctive, and genuinely fun |
| **Richer order types** | Stop, iceberg, post-only, midpoint peg; price bands and circuit breakers. | Depth on the part interviewers probe hardest |

---

## Part 9 — Verification

- **Per service** — unit + property tests: order book invariants, ledger balance, FIX round-trip.
- **Protocol conformance** — the Rust acceptor must interoperate with **QuickFIX**, not just with your
  own TS initiator. Two of your own implementations agreeing proves less than one of them agreeing
  with a third party.
- **Determinism** — replay a recorded journal and reproduce identical books and fills.
- **End to end** — a scripted scenario asserting state in every service's database along the way:
  place → risk-check → FIX → match → execution report → ledger entry → derived holdings.
- **Chaos** — kill each service mid-flight; assert no lost, duplicated or double-executed orders.

**Invariants that must never break**
```
Σdebits == Σcredits, per journal entry, per asset
derived positions == independent tally of fills
no order fills more than its quantity
market data feed_seq and symbol_seq are gapless
journal replay reproduces a byte-identical order book
```
