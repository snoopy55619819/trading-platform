# broker-backend — Milestones 5 & 6

**One process, four modules.** `ledger` and `oms` share a process because they share a
transaction: checking buying power and writing the order is one commit.

Status: **M5 ledger done** (10 tests against Postgres) · M6 = oms + api + fix, not started

```
pnpm db:up && pnpm backend db:migrate && pnpm backend db:seed   # from the repo root
pnpm test                                                        # rolled back: leaves no data
pnpm ledger open "Ada"   then  deposit / fill / settle / show / recon   (src/ledger/cli.ts)
```

## Inputs / outputs

| | |
|---|---|
| **In** | HTTP from `web` (auth, place/cancel order, positions, blotter). FIX `ExecutionReport`s from the exchange. |
| **Out** | FIX `NewOrderSingle`/`OrderCancelRequest` to the exchange. JSON to `web`. |
| **Owns** | The `broker` schema: accounts, orders, order events, journal entries, risk limits, security master |
| **Does NOT** | serve market data. `web` gets prices from `market-data` and joins them itself. |

## Ledger (M5) — build this first

It has no dependency on the exchange, so it is a good parallel track.

- [x] `ledger_accounts` — `CLIENT_CASH`, `CLIENT_SECURITIES_UNSETTLED`,
      `CLIENT_SECURITIES_SETTLED`, `FEES_REVENUE`, `HOUSE_CASH`, `STREET_CONTRA`
- [x] `journal_entries` + `journal_lines`, with `asset` (`'CASH'` or a ticker)
- [x] **Constraint in the database:** per entry, per asset, `SUM(debit) = SUM(credit)`.
      This belongs in Postgres where it cannot be bypassed, not in application code.
- [x] `postFill()` — one entry, three balanced pairs: cash, fee, shares into
      `CLIENT_SECURITIES_UNSETTLED`. Idempotent on `fill_id`.
- [x] `creditCash()` for opening balances — otherwise no order can ever pass risk
- [x] **Positions and cash derived by summing journal lines.** No stored running total.
- [x] Auto-settle job: `UNSETTLED → SETTLED`, immediate in v1. Post-MVP the same job waits
      for T+1 — the change is *when it fires*, not the schema.
- [x] Reconciliation: `Σdebits == Σcredits` per asset; derived positions match an
      independent tally of fills
- [x] Test: post 1,000 random fills, assert both invariants hold

**Done.** The 1,000-fill test (five clients, five symbols, buys and sells, fees and
rebates, settlement interleaved) matches an in-memory tally to the cent and the share, and
reconciliation passes. Mutation-checked: getting a rebate's direction wrong, or making the
positions check compare the ledger with itself, each fails a test.

### What the database enforces (`migrations/0002_ledger.sql`)

| Rule | How |
|---|---|
| Every entry balances, per asset | deferred constraint trigger, checked at commit, so an entry is built line by line and judged whole |
| Every entry has lines | the same trigger, fired by the entry itself |
| Shares never land in a cash account | composite foreign key `(ledger_account_id, asset)` |
| A line is a debit or a credit, positive, never both | `CHECK` |
| History is append-only | triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` |
| A fill, deposit or settlement is booked once | unique `(reference_type, reference_id)` |
| Account types carry the right asset and normal balance | `CHECK`s on `ledger_accounts` |

### Ledger decisions

- **These are the broker's books.** Cash and shares held for clients are owed to them, so
  client accounts are credit-normal; `HOUSE_CASH` and `STREET_CONTRA` are debit-normal.
  `account_balances` reports every balance in its normal direction, so a positive number
  always means "holds what it says".
- **A buy:** `Dr CLIENT_CASH / Cr STREET_CONTRA` (notional), `Dr CLIENT_CASH /
  Cr FEES_REVENUE` (fee, reversed for a rebate), `Dr STREET_CONTRA / Cr
  CLIENT_SECURITIES_UNSETTLED` (shares). A sell reverses each pair.
- **Settlement is per fill.** `fills.settlement_date` is the trade date in v1
  (`SETTLEMENT_DAYS = 0`); the settle job books fills due on or before a date, each once.
  T+1 changes that one number.
- **`fills` is recorded alongside the journal**, so reconciliation can tally positions,
  cash and fees a second way. The OMS writes it from execution reports at M6.
- **Every function takes the caller's transaction.** At M6 the buying-power check, the order
  write and (later) the fill booking each commit together with what caused them.
- **ULIDs** for ledger and account ids (`src/ids.ts`, written rather than imported).

### Ledger known gaps

- **Buying power is not here yet.** It is settled cash less what working buy orders have
  reserved, and reservations arrive with orders at M6. `cashBalance` is the ledger's half.
- **No cost basis.** Average cost per position needs a method choice (average or FIFO) and
  belongs with the positions API at M6.
- **The street side never settles.** `STREET_CONTRA` holds what the market owes and is owed
  until a clearing model exists (it becomes `CLEARING_RECEIVABLE`/`PAYABLE` then).
- **Nothing runs the settle job or reconciliation on a timer yet.** That needs the backend
  process, at M6. Until then: `pnpm ledger settle` and `pnpm ledger recon`.

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
