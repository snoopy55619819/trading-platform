# trading-platform

An end-to-end simulation of the equities trading lifecycle, built to learn how market
infrastructure actually fits together. A client places an order; it flows through a broker API,
an OMS with pre-trade risk, a hand-rolled FIX 4.4 session to an exchange, a price-time-priority
matching engine, and back out as both a private execution report and a public market data print —
landing in holdings backed by a real double-entry ledger.

Entirely synthetic. No real market data, no real money.

See [PLAN.md](PLAN.md) for the full architecture, service catalogue and milestone breakdown.

## The shape of it

```
                    ORDER PLANE (FIX 4.4 / gRPC)
  Web UI ──▶ broker-api ──▶ oms ──FIX──▶ fix-gateway ──▶ matching-engine
                              │                                 │
                              ▼                          ┌──────┴──────┐
                       broker-ledger                     │             │
                     (double-entry)              ExecutionReport   BookDelta/Trade
                                                   (private)         (public)
                                                        │             │
                    MARKET DATA PLANE                   │             ▼
                                                        │      md-publisher
                                                        │             │
                                          back to oms ◀─┘             ├──▶ tick-store ──▶ chart
                                                                      └──▶ broker-api WS
  simulator ──FIX──▶ fix-gateway    (synthetic agents keep the book alive 24/7)
```

The key idea: **order flow and market data are two independent planes.** A fill you caused
reaches you twice by two separate routes — privately as your execution report, publicly as an
anonymous print on the tape.

## Layout

| Path | What lives here |
|---|---|
| `contracts/` | Protobuf definitions, the FIX 4.4 dictionary subset, reference data seeds. Load-bearing — it's what lets Rust and TypeScript services agree without sharing code |
| `services/exchange/` | Rust cargo workspace: `fix-core`, `fix-gateway`, `matching-engine`, `md-publisher` |
| `services/oms/` | Order management: risk checks, order state machine, FIX initiator |
| `services/broker-ledger/` | Double-entry ledger. Positions and cash are *derived*, never incremented |
| `services/tick-store/` | Tick persistence and OHLCV bar rollups for charts |
| `services/simulator/` | Synthetic market participants, trading over the same public FIX path |
| `services/broker-api/` | REST + WebSocket BFF for the UI |
| `web/` | Minimal React client |
| `infra/` | docker-compose, Postgres migrations, seed scripts |
| `docs/` | ADRs, sequence diagrams, domain glossary, FIX message catalogue |

## Status

Milestone 0 — foundations. Structure scaffolded; contracts not yet written.
