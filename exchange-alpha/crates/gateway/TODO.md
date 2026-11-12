# gateway — Milestone 2

**The exchange's door, and the binary you run.** The only crate that has heard of both
FIX and order books — which is precisely why the other three haven't.

Status: **done** · 14 tests (3 of them market data, added in M3), plus QuickFIX conformance

```
docker compose -f compose.yml up -d --wait     # the exchange's own database
cargo run -p gateway                           # FIX on 127.0.0.1:9878, market data on :9879
./conformance/run.sh                           # QuickFIX trades, crash, recovery
```

## Inputs / outputs

| | |
|---|---|
| **In** | FIX 4.4 over TCP from any participant (the broker, the simulator) |
| **Out** | `Command`s to the engine; FIX `ExecutionReport`s back to the originating session; engine events forwarded to md-publisher |
| **Owns** | Session state (persisted), participant identity, all validation |
| **Database** | Its own — created at this milestone. **Not** a schema in the broker's. |

## Checklist

### 1. Server
- [x] TCP listener, one task per connection
- [x] Session lifecycle: logon → active → logout/disconnect
- [x] Map `SenderCompID` to a participant id — this is who the engine credits the order to
- [x] Reject a second concurrent session for the same CompID

### 2. Validation, before the engine sees anything
- [x] Symbol exists and is `ACTIVE` (read from `spec/listings.json` at boot — no database)
- [x] `price_cents % tick_size_cents == 0`
- [x] `qty % lot_size == 0` and `qty > 0`
- [x] Price within `reference_price_cents ± price_band_pct`
- [x] `Price` present for Limit, absent for Market
- [x] Duplicate `ClOrdID` for this session and business date
- [x] Each rejection maps to a specific `OrdRejReason` — never a bare "rejected"

### 3. Translation
- [x] `NewOrderSingle(D)` → engine `NewOrder`
- [x] `OrderCancelRequest(F)` → engine `Cancel`
- [x] Engine `Trade`/`Accepted`/`Rejected` → `ExecutionReport(8)` with the right `ExecType`
      and `OrdStatus`, running `CumQty`/`LeavesQty`/`AvgPx`
- [x] `LastLiquidityInd(851)` set correctly — the fee schedule depends on maker vs taker
- [x] Cancel rejections → `OrderCancelReject(9)`, not a session-level reject
- [x] **An execution report goes only to the session that owns the order.** Getting this
      wrong leaks one participant's activity to another.

### 4. Persistence
- [x] Own database and migrations: `fix_sessions` (seq numbers), `fix_outbound_store`
- [x] Sequence numbers survive a restart

### 5. Tests
- [x] Each validation rule rejects with the right reason
- [x] Two sessions trade against each other; each sees only its own reports
- [x] Kill the gateway mid-session; on restart the client's resend recovers cleanly

## Done when

A QuickFIX client and the broker's TypeScript initiator can both log on, trade against
each other through the book, and recover from a mid-session kill.

**Met for QuickFIX** (`conformance/run.sh`, QuickFIX/Go loading `spec/fix44.xml`): two
sessions trade, cancel and are rejected; the gateway is killed with SIGKILL and restarted;
the book survives; a fill that happened while a client was away reaches it by resend with
`PossDupFlag=Y`. The broker's TypeScript initiator is built in M6 (`broker/backend/TODO.md`);
this test is how it will be checked.

## Design

One task (`core.rs`) owns the engine, the order tracker and every FIX session. Connection
tasks only move bytes. Matching therefore stays single-threaded and deterministic however
many clients connect, with no locks.

Sessions are keyed by CompID, not connection. A disconnected client's session lives on:
reports for its orders are numbered and stored, and the gap shows up when it logs back on.

Order state for execution reports (`CumQty`, `LeavesQty`, `AvgPx`) is derived purely from
engine events, so replaying the journal rebuilds it exactly. Nothing extra to persist.

Only a **live** order keeps that full record. When it fills, is cancelled or expires, it
shrinks to a small entry under its `ClOrdID` (order id and how it ended), which is enough to
answer a late cancel "too late" with the right status and to keep the `ClOrdID` spent for the
day. Keeping every order's full record until the roll grew the live gateway to 234 MB by
mid-day, almost all of it market maker quotes cancelled within seconds (ADR 0005).

## Decisions

- **Participant = `CompID/Account`.** Self-trade prevention applies per account, so two clients
  of the same broker may trade with each other; cancels must come from the same session and
  account.
- **`ExecID` = `{journal seq}-{n}`.** Replay reproduces the journal sequence, so ids stay
  unique across restarts with nothing extra stored. Rejections that never reach the engine
  use `R{time}-{n}`.
- **Fees on every fill:** `Commission(12)` with `CommType=3` (absolute), maker rebate negative,
  rounded half away from zero in integer cents.
- **A canceled order's report carries the cancel request's `ClOrdID`**, and `OrderID` ties it
  to the order. (The published spec has no `OrigClOrdID` on `ExecutionReport`.)
- **Authentication is a CompID allowlist** (`ALPHA_COMP_IDS`). The spec's Logon has no
  username or password fields.
- **One process, two ports** (M3). `Gateway::start` also starts md-publisher's WebSocket
  server. After each command the core sends the public part of its events down an unbounded
  channel, so order entry never waits on market data. `Core::open` replays the journal
  through the feed too and returns it, so feed sequence numbers survive a crash.
- **Business days** (post-MVP). At the venue's roll (21:00 UTC) the core journals an
  `EndOfDay`: resting day orders expire with `ExecType=C`, the order tracker forgets finished
  orders and used `ClOrdID`s, a snapshot is written and the journal moves to the next day's
  file in `ALPHA_DATA_DIR`. A start loads the newest snapshot and replays only its day,
  finishing a roll it was stopped in the middle of, or closing the day if it was down at the
  roll time. `ALPHA_ROLL_EVERY_SECS` rolls more often, to watch it happen. See `src/days.rs`.

## Known gaps

- **Crash window.** A command is journaled, then the reports it produces are stored for
  resend. A crash between the two loses those reports: the trade happened, the client is
  never told. The fix is to regenerate reports from the journal on recovery, or to keep FIX
  state in the same journal. Worth doing before anything depends on it.
- **Rejected `ClOrdID`s are forgotten on restart.** Accepted orders are rebuilt from the
  journal; orders rejected before the engine, and cancel requests, are not journaled. Since
  business days, only ids used since the day's snapshot can be lost this way.
- **Slow clients are unbounded.** A connection's outbound queue has no limit.

## Found by conformance testing

QuickFIX refused to load the published spec at all: its root element lacked `type="FIX"`.
Our own parser never cared, which is exactly the class of bug only an independent
implementation catches. Fixed in spec 1.0.1; the broker re-synced its vendored copy.
