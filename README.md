# trading-platform

An end-to-end simulation of the equities trading lifecycle, built to learn how market
infrastructure actually fits together. Entirely synthetic — no real market data, no real money.

See [PLAN.md](PLAN.md) for the architecture and milestone breakdown.

## Organised by company, not by service

The top level mirrors the real world: **each folder is a business that would exist
independently.** They share no code, no build, and no contracts directory.

```
exchange-alpha/   Alpha Exchange        (Rust)  — publishes spec/, everything else is private
broker/           A broker-dealer       (TS)    — api, oms, ledger, tick-store, web
participants/     Other trading firms   (TS)    — the simulated market
infra/            The shared local Postgres container
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
     │  HTTP + WebSocket
     ▼
    api  [2]
     │
     │  gRPC  PlaceOrder
     ▼
    oms  [3]
     │
     │════ FIX 4.4 / TCP ═══════════════════▶  gateway  [4]
     │       NewOrderSingle (35=D)                 │
     │                                            ▼
     │                                     matching-engine  [5]
     │                                            │
     │◀═══ FIX 4.4 / TCP ═════════════════════════╯
     │       ExecutionReport (35=8)  [6]
     │
     │  Fill
     ▼
    ledger  [7]


════════════════════════════ MARKET DATA PLANE ════════════════════════════
         public · broadcast · sequenced · anonymous · everyone sees it

                              matching-engine  [5]
                                      │
                                      │  BookDelta · Trade
                                      ▼
                              md-publisher  [8]
                                      │
                                      │  WS  [9]
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
        tick-store  [10]             api                participants  [11]
              │                       │                       │
              │  chart history        │  live prices          │  orders
              └──────▶ api ───────────┴──────▶ web            └──▶ ORDER PLANE
```

| | Component | What it does |
|---|---|---|
| **[1]** | `web` | The client. Symbol picker, chart, depth ladder, holdings, order ticket. |
| **[2]** | `api` | The front door — the only thing exposed outside. Auth, sessions, rate limits, and reshaping internal data for the UI. No business logic. |
| **[3]** | `oms` | **Gatekeeper**: buying power, symbol valid, price within band, duplicate order id. **Tracker**: the lifecycle `PendingNew → New → PartiallyFilled → Filled`. Also the broker's FIX initiator. |
| **[4]** | `gateway` | The exchange's door. Session authentication and sequence numbers, then validation — tick size, lot size, price band, duplicate `ClOrdID` — before the engine sees anything. |
| **[5]** | `matching-engine` | The market itself. Holds every resting order and decides who trades with whom: best price first, FIFO within a price. No database — RAM plus an append-only journal, recovered by replay. |
| **[6]** | `ExecutionReport` | The **private** result. Carries `exec_id`, `account_id`, `client_order_id`, `last_qty`, `last_px`, fees. Goes to the order's owner and nobody else. |
| **[7]** | `ledger` | Double-entry books, and the authoritative answer to "what do I own, what can I spend". Positions and cash are **derived** by summing journal lines, never stored as a running total. |
| **[8]** | `md-publisher` | Broadcasts book changes to every subscriber. Never learns whose order moved the book. |
| **[9]** | The feed | `Snapshot` · `BookDelta` · `TradePrint` · `Heartbeat`, each stamped with `feed_seq`. A gap in that sequence means you **lost data** — recover with a snapshot, never silently continue. |
| **[10]** | `tick-store` | **History, not live prices.** Subscribes to the same feed and persists it, rolling ticks into 1m/5m/1h/1d candles. If it died, live prices would keep ticking and only the chart would break. |
| **[11]** | `participants` | Other trading firms — a third party, not part of either company. They read the same public feed and send orders through the same public gateway. **The simulator gets no backdoor**, which is what makes it a valid test of the whole system. |

**`fix-core` is deliberately not on the diagram.** It is a *library*, not a server: the FIX
codec plus the session state machine (heartbeats, sequence numbers, resend). The gateway
links it in, and the OMS links its own initiator against the same published dictionary. It
has never heard of an order book.

**What the two planes must never share:** `TradePrint` has no field for an account or a
client order id — structurally, not by convention. Leaking one onto the public feed would be
a correctness bug, so the schema makes it impossible to write.

## Getting started

```bash
pnpm db:up                              # Postgres
cd exchange-alpha && cargo build        # the exchange
cd broker && pnpm install && pnpm db:migrate && pnpm db:seed
```

Each company installs its own dependencies — there is deliberately no workspace spanning
them. Root `package.json` holds only convenience shortcuts (`pnpm db:reset`,
`pnpm broker:bootstrap`).

## Status

**Milestone 0 — foundations: complete.** Specs defined and linted, security master seeded,
Postgres running, both toolchains building, spec vendoring with drift detection.

Next: **Milestone 1 — the matching engine** (`exchange-alpha/crates/matching-engine`).
Order book with price-time priority, limit / market / IOC / FOK, append-only journal.
Done when replaying the journal reproduces a byte-identical book and the benchmark
reports p50/p99 match latency.
