# broker-backend — Milestones 5 & 6

**One process, four modules.** `ledger` and `oms` share a process because they share a
transaction: checking buying power and writing the order is one commit.

Status: **not started** · M5 = ledger, M6 = oms + api + fix

## Inputs / outputs

| | |
|---|---|
| **In** | HTTP from `web` (auth, place/cancel order, positions, blotter). FIX `ExecutionReport`s from the exchange. |
| **Out** | FIX `NewOrderSingle`/`OrderCancelRequest` to the exchange. JSON to `web`. |
| **Owns** | The `broker` schema: accounts, orders, order events, journal entries, risk limits, security master |
| **Does NOT** | serve market data. `web` gets prices from `market-data` and joins them itself. |

## Ledger (M5) — build this first

It has no dependency on the exchange, so it is a good parallel track.

- [ ] `ledger_accounts` — `CLIENT_CASH`, `CLIENT_SECURITIES_UNSETTLED`,
      `CLIENT_SECURITIES_SETTLED`, `FEES_REVENUE`, `HOUSE_CASH`, `STREET_CONTRA`
- [ ] `journal_entries` + `journal_lines`, with `asset` (`'CASH'` or a ticker)
- [ ] **Constraint in the database:** per entry, per asset, `SUM(debit) = SUM(credit)`.
      This belongs in Postgres where it cannot be bypassed, not in application code.
- [ ] `postFill()` — one entry, three balanced pairs: cash, fee, shares into
      `CLIENT_SECURITIES_UNSETTLED`. Idempotent on `fill_id`.
- [ ] `creditCash()` for opening balances — otherwise no order can ever pass risk
- [ ] **Positions and cash derived by summing journal lines.** No stored running total.
- [ ] Auto-settle job: `UNSETTLED → SETTLED`, immediate in v1. Post-MVP the same job waits
      for T+1 — the change is *when it fires*, not the schema.
- [ ] Reconciliation: `Σdebits == Σcredits` per asset; derived positions match an
      independent tally of fills
- [ ] Test: post 1,000 random fills, assert both invariants hold

## OMS (M6)

- [ ] `orders` and `order_events` (append-only; the `orders` row is a projection of it)
- [ ] State machine: `PendingNew → New → PartiallyFilled → Filled | Canceled | Rejected | Expired`.
      Terminal states are terminal — assert no transition leaves them.
- [ ] Pre-trade risk, **all inside one transaction with the order write**:
      buying power (from the ledger module) · position limit · price band · tick size ·
      lot size · symbol status · duplicate `ClOrdID` · rate limit
- [ ] Every rejection names a `RejectReason` — a bare "rejected" is a bug
- [ ] Reserve buying power on a working buy order, release on cancel/fill
- [ ] Apply incoming `ExecutionReport`s: update `filled_qty`, `avg_price`, status; hand a
      `Fill` to the ledger

## FIX initiator (M6)

- [ ] TypeScript FIX client against `vendor/exchange-alpha/fix44.xml` — **independent of
      the Rust implementation.** Do not port their code; that would defeat the test.
- [ ] Session lifecycle, sequence numbers, resend on gap, persisted across restarts
- [ ] Reconnect with backoff; orders placed while disconnected must fail loudly
- [ ] **Single instance only** — a FIX session is a stateful singleton, and two replicas
      cannot share a `SenderCompID`

## API (M6)

- [ ] Auth and sessions
- [ ] `POST /orders`, `DELETE /orders/:id`, `GET /orders`, `GET /positions`, `GET /symbols`
- [ ] Rate limiting
- [ ] Idempotent order placement keyed on `clientOrderId`
- [ ] No business logic here — it calls the oms and ledger modules

## Done when

`curl` an order → risk-checked → FIX to the exchange → filled → ledger updated → holdings
correct. Bad orders rejected for the **right** reason, verified per rule.
