# trading-platform

An end-to-end simulation of the equities trading lifecycle, built to learn how market
infrastructure actually fits together. Entirely synthetic — no real market data, no real money.

See [PLAN.md](PLAN.md) for the architecture and milestone breakdown.

## Organised by company, not by service

The top level mirrors the real world: **each folder is a business that would exist
independently.** They share no code, no build, and no contracts directory.

```
exchange-alpha/   Alpha Exchange        (Rust)  — publishes spec/, everything else is private
broker/           A broker-dealer       (TS)    — backend, market-data, web
                                                  three deployables, nothing shared
participants/     Other trading firms   (TS)    — the simulated market
```

Cross-company interfaces work the way they do in the industry: **the exchange publishes a
spec, and everyone else implements against it.** Nasdaq doesn't co-own a schema repo with
Schwab — it publishes a FIX spec and firms build to it.

```
exchange-alpha/spec/          fix44.xml · marketdata.proto · listings.json   ← published
        │
        │  pnpm spec:sync   (a deliberate act, version-stamped)
        ▼
broker/vendor/exchange-alpha/ ← the version this broker is currently built for
```

`pnpm spec:check` fails when the vendored copy falls behind. That isn't a repo problem —
it's integration work, and handling it is part of what this project is for.

Inside a company, sharing is fine: `broker/contracts/` is shared by the broker's own
services because they genuinely are one team's codebase.

## How it fits together

The single most important structural fact: **this is not one pipeline, it is two independent
planes.** The same match reaches you twice, by two different routes, carrying two different
things — privately as your execution report, publicly as an anonymous print on the tape.

```
═══════════════════════════════ ORDER PLANE ═══════════════════════════════
         private · authenticated · request/response · only your data

    BROKER                                        ALPHA EXCHANGE
    ──────                                        ──────────────

    web  [1]
     │
     │  HTTP  auth · orders · positions · symbol list
     ▼
   ┌─────────────────────┐
   │  backend       [2]  │      one process, one transaction
   │  ─────────────────  │
   │   api    front door │
   │   oms    risk +     │
   │          lifecycle  │
   │   ledger books      │
   │   fix    session    │
   └──────────┬──────────┘
              │
              │═══ FIX 4.4 / TCP ══ NewOrderSingle (35=D) ═══▶  gateway  [3]
              │                                                    │
              │                                                    ▼
              │                                             matching-engine  [4]
              │                                                    │
              │◀══ FIX 4.4 / TCP ══ ExecutionReport (35=8)  [5] ═══╯


════════════════════════════ MARKET DATA PLANE ════════════════════════════
         public · broadcast · sequenced · anonymous · everyone sees it

                              matching-engine  [4]
                                      │
                                      │  BookDelta · Trade
                                      ▼
                              md-publisher  [6]
                                      │
                                      │  WS  [7]
                                      │
                    ┌─────────────────┴───────────────────┐
                    ▼                                     ▼
             market-data  [8]                      participants  [9]
                    │                                     │
                    │  live prices (WS)                   │  orders
                    │  chart history (REST)               │
                    ▼                                     │
                   web                                    └──▶ ORDER PLANE
```

`web` talks to **two** services and joins them itself: positions from `backend`, prices from
`market-data`. That is what keeps the backend free of any market-data dependency.

| | Component | What it does |
|---|---|---|
| **[1]** | `web` | The client. A static bundle, not a server. |
| **[2]** | **`backend`** | One process, three modules. **api** — front door: auth, sessions, rate limits, no business logic. **oms** — gatekeeper (buying power, symbol valid, price in band, duplicate order id) and lifecycle tracker. **ledger** — double-entry books; positions and cash *derived* by summing journal lines, never incremented. Plus the **fix** session. They share a process because they share a transaction: checking buying power and writing the order is one commit. Single-instance — a FIX session is a stateful singleton and two replicas cannot share a `SenderCompID`. |
| **[3]** | `gateway` | The exchange's door. Session authentication and sequence numbers, then validation — tick size, lot size, price band, duplicate `ClOrdID` — before the engine sees anything. |
| **[4]** | `matching-engine` | The market itself. Every resting order, and who trades with whom: best price first, FIFO within a price. No database — RAM plus an append-only journal, recovered by replay. |
| **[5]** | `ExecutionReport` | The **private** result: `exec_id`, `account_id`, `client_order_id`, `last_qty`, `last_px`, fees. To the order's owner and nobody else. |
| **[6]** | `md-publisher` | Broadcasts book changes to every subscriber. Never learns whose order moved the book. |
| **[7]** | The feed | `Snapshot` · `BookDelta` · `TradePrint` · `Heartbeat`, each stamped with `feed_seq`. A gap means you **lost data** — recover with a snapshot, never silently continue. |
| **[8]** | `market-data` | Live fanout *and* chart history. Its own database, its own vendored spec, no shared code with the backend — so it could be rewritten in Go and nothing else would change. It sits on the anonymous plane, which is why it needs none of the backend's domain types. |
| **[9]** | `participants` | Other trading firms — a third party, not part of either company. Same public feed, same public gateway. **The simulator gets no backdoor.** |

**Where the boundaries are, and why.** The company boundary is real: two businesses, a
network between them, FIX as the contract. Inside the broker, `api`/`oms`/`ledger` are *not*
separate — splitting them would make a buying-power check non-transactional in exchange for
nothing. `market-data` is separate on technical grounds: different workload, different
database, no transactional coupling.

**`fix-core` is deliberately not on the diagram.** It is a *library*, not a server: the FIX
codec plus the session state machine. The gateway links it in, and the backend links its own
initiator against the same published dictionary. It has never heard of an order book.

**What the two planes must never share:** `TradePrint` has no field for an account or a
client order id — structurally, not by convention. Leaking one onto the public feed would be
a correctness bug, so the schema makes it impossible to write.

## Running it

**What exists today (milestone 0):** the broker's database, and an exchange binary that
prints a placeholder. `backend`, `market-data`, `web` and `simulator` are scaffolding —
directories, configs and specs, no code. The first runnable service is the matching engine
at M1.

### First time

```bash
cd exchange-alpha && cargo build
```

```bash
cd broker/backend && pnpm install
```

```bash
cd broker/market-data && pnpm install
```

Each installs independently — there is no workspace, and no root install.

### Start the database

```bash
docker compose -f broker/compose.yml up -d --wait
```

```bash
cd broker/backend && pnpm db:migrate && pnpm db:seed
```

`--wait` blocks until the healthcheck passes, so the migration never races the container.

### Look at the database

No local `psql` needed — go through the container:

```bash
docker compose -f broker/compose.yml exec broker-postgres psql -U broker -d broker
```

If you do have `psql` locally (`brew install libpq`), or want to point a GUI at it
(TablePlus, DBeaver, DataGrip):

```
postgres://broker:broker@127.0.0.1:5432/broker
```

Useful once you are in:

| | |
|---|---|
| `\dn` | list schemas — you should see `broker` |
| `\dt broker.*` | its tables: `securities`, `schema_migrations` |
| `\d broker.securities` | columns **and the CHECK constraints** |
| `SELECT * FROM broker.securities;` | the seeded instruments |
| `SELECT * FROM broker.schema_migrations;` | what has been applied, and when |

### Run the exchange

```bash
cd exchange-alpha && cargo run
```

### Shortcuts from the repo root

| | |
|---|---|
| `pnpm db:up` / `pnpm db:down` | start / stop Postgres |
| `pnpm db:reset` | wipe the volume, re-migrate, re-seed |
| `pnpm spec:check` | fail if any vendored venue spec is stale |
| `pnpm backend <script>` | run a script inside `broker/backend` |

These are conveniences only. Everything they do you can do from inside the folder itself —
no deployable depends on the repo root to build, run or deploy.

## Status

**Milestone 0 — foundations: complete.** Specs defined and linted, security master seeded,
Postgres running, both toolchains building, spec vendoring with drift detection.

Next: **Milestone 1 — the matching engine** (`exchange-alpha/crates/matching-engine`).
Order book with price-time priority, limit / market / IOC / FOK, append-only journal.
Done when replaying the journal reproduces a byte-identical book and the benchmark
reports p50/p99 match latency.
