# broker-backend — Milestones 5 & 6

**One process, four modules.** `ledger` and `oms` share a process because they share a
transaction: checking buying power and writing the order is one commit.

Status: **done** · M5 ledger, M6 oms + fix + api · 27 tests (database tests rolled back)

```
pnpm db:up && pnpm backend db:migrate && pnpm backend db:seed   # from the repo root, once
pnpm start                                                       # the API on :8080, FIX to the exchange
pnpm test                                                        # leaves no data behind
pnpm ledger show <account>                                       # inspect the books by hand
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
- **Cost basis is average cost only** (added for M8, in `ledger/cost.ts`). FIFO or
  specific-lot accounting, which tax reporting may need, would be a different method over
  the same fills.
- **The street side never settles.** `STREET_CONTRA` holds what the market owes and is owed
  until a clearing model exists (it becomes `CLEARING_RECEIVABLE`/`PAYABLE` then).
- **Nothing runs the settle job or reconciliation on a timer yet.** That needs the backend
  process, at M6. Until then: `pnpm ledger settle` and `pnpm ledger recon`.

## OMS (M6)

- [x] `orders` and `order_events` (append-only; the `orders` row is a projection of it)
- [x] State machine: `PendingNew → New → PartiallyFilled → Filled | Canceled | Rejected | Expired`.
      Terminal states are terminal — assert no transition leaves them. (`oms/state.ts`, and a
      trigger in the database as well)
- [x] Pre-trade risk, **all inside one transaction with the order write**:
      buying power (from the ledger module) · position limit · price band · tick size ·
      lot size · symbol status · duplicate `ClOrdID` · rate limit. Plus order value, no
      short selling, and venue availability.
- [x] Every rejection names a `RejectReason` — a bare "rejected" is a bug
- [x] Reserve buying power on a working buy order, release on cancel/fill
- [x] Apply incoming `ExecutionReport`s: update `filled_qty`, `avg_price`, status; hand a
      `Fill` to the ledger

## FIX initiator (M6)

- [x] TypeScript FIX client against `vendor/exchange-alpha/fix44.xml` — **independent of
      the Rust implementation.** Do not port their code; that would defeat the test.
- [x] Session lifecycle, sequence numbers, resend on gap, persisted across restarts
- [x] Reconnect with backoff; orders placed while disconnected must fail loudly
      (`VENUE_UNAVAILABLE`)
- [x] **Single instance only** — a FIX session is a stateful singleton, and two replicas
      cannot share a `SenderCompID` (a Postgres advisory lock refuses a second process)

## API (M6)

- [x] Auth and sessions (scrypt password hashes; bearer tokens in memory)
- [x] `POST /orders`, `DELETE /orders/:id`, `GET /orders`, `GET /positions`, `GET /symbols`
      (also `POST /users`, `POST /sessions`, `POST /deposits`, `GET /orders/:id` with history)
- [x] Rate limiting (20 requests a second per client, as well as the per-account order rate)
- [x] Idempotent order placement keyed on `clientOrderId`
- [x] No business logic here — it calls the oms and ledger modules

## For the web client (M8)

Done: CORS (an origin allowlist, `BROKER_WEB_ORIGIN`), cost basis on `/positions`
(`costBasisCents`, `avgCostCents`, `realizedPnlCents`, by the average-cost method from
`fills`, fees included), a watchlist (`GET /watchlist`, `PUT` and `DELETE
/watchlist/:symbol`, five defaults for a new account), and `GET /status`. Details in
[`broker/web/TODO.md`](../web/TODO.md), section 1.

## Done when

`curl` an order → risk-checked → FIX to the exchange → filled → ledger updated → holdings
correct. Bad orders rejected for the **right** reason, verified per rule.

**Met**, against the real exchange with the simulator providing liquidity:

- A market buy of 100 ACME reserved $5,053.52 (100 shares at the top of the price band plus
  the worst fee), filled at $42.15, and left cash at $50,000.00 − $4,215.00 − $1.26 =
  $45,783.74 exactly, with 100 shares settled a second later.
- Each rule refused its own case: `MALFORMED_REQUEST` (400), `UNKNOWN_SYMBOL`,
  `INVALID_TICK_SIZE`, `PRICE_OUT_OF_BAND`, `ORDER_VALUE_LIMIT_EXCEEDED`,
  `INSUFFICIENT_BUYING_POWER`, `INSUFFICIENT_POSITION` (including shares already promised to
  a working sell), `RATE_LIMIT_EXCEEDED` (at exactly 60 a minute), `VENUE_UNAVAILABLE`
  (exchange killed), `DUPLICATE_CLIENT_ORDER_ID` (409; the same order again returns the
  original), `TOO_LATE_TO_CANCEL`.
- **A fill while the broker was down was not lost.** A buy rested inside the spread, the
  backend was `kill -9`'d, another firm sold into it, and on restart the backend asked the
  exchange to resend, booked the fill, and showed the order FILLED with cash correct to
  the cent.
- The exchange was `kill -9`'d and restarted: the backend reconnected by itself with its
  sequence numbers intact, and reconciliation passed over everything booked.

## OMS, FIX and API decisions

- **Commit, then send.** An order is committed (risk-checked, `PENDING_NEW`) before a byte
  leaves. The FIX send then stores the message, its sequence number and `sent_at` in one
  transaction before writing to the socket. A crash between the two leaves an order
  committed but unsent, and the next logon sends it.
- **Marking an order sent succeeds once, and only while it is still `PENDING_NEW`.** So the
  logon sweep and the original placement cannot both send it (the exchange would refuse
  the second as a duplicate ClOrdID, which would read as the live order being rejected),
  and an order cancelled before it was sent never goes.
- **Sequence numbers are never reset after the first logon.** A number is saved before the
  bytes that use it; an execution report's effects commit in the same transaction that
  moves `next_in_seq` past it. Missed reports are recovered by `ResendRequest`; orders the
  exchange missed are resent from `fix_outbound` with `PossDupFlag=Y` (the exchange's
  ClOrdID check makes a resend safe). Reset by hand: `DELETE FROM broker.fix_session`.
- **An execution report is applied once**, keyed on its `ExecID` (unique in
  `order_events`), so a resend changes nothing the second time.
- **The broker's order id is the ClOrdID.** A ULID, unique for the life of the session,
  which the exchange requires; the client's own `clientOrderId` is only the idempotency
  key, unique per account.
- **Buying power = cash − what working buys reserve.** A buy reserves its worst cost: the
  limit price, or for a market order the top of the price band (nothing can rest above
  it, so nothing can trade above it), plus the higher of the two fees. The account row is
  locked for the whole placement, so two orders cannot spend the same cash.
- **No short selling.** A sell may use only what is held, less what working sells have
  already promised.
- **Rejected orders are recorded**, with their reason, except when there is nothing to
  record them against (an unknown symbol) or the request was malformed.
- **Business date** for fills follows the venue's roll at 21:00 UTC, not the UTC date.

## OMS, FIX and API known gaps

- **No order-status reconciliation with the exchange.** If the exchange loses its journal,
  orders the broker thinks are working stay working. FIX's answer is OrderStatusRequest or
  a mass status, which the published spec does not include.
- **Sessions live in memory**: a restart logs everyone out.
- **`fix_outbound` keeps every message forever.** Fine for now; a daily prune once a
  business date exists.
- **DAY behaves like GTC.** Nothing expires orders at the end of the day until a clock
  service exists.
