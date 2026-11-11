# gateway — Milestone 2

**The exchange's door, and the binary you run.** The only crate that has heard of both
FIX and order books — which is precisely why the other three haven't.

Status: **not started** · depends on: `fix-core`, `matching-engine`

## Inputs / outputs

| | |
|---|---|
| **In** | FIX 4.4 over TCP from any participant (the broker, the simulator) |
| **Out** | `Command`s to the engine; FIX `ExecutionReport`s back to the originating session; engine events forwarded to md-publisher |
| **Owns** | Session state (persisted), participant identity, all validation |
| **Database** | Its own — created at this milestone. **Not** a schema in the broker's. |

## Checklist

### 1. Server
- [ ] TCP listener, one task per connection
- [ ] Session lifecycle: logon → active → logout/disconnect
- [ ] Map `SenderCompID` to a participant id — this is who the engine credits the order to
- [ ] Reject a second concurrent session for the same CompID

### 2. Validation, before the engine sees anything
- [ ] Symbol exists and is `ACTIVE` (read from `spec/listings.json` at boot — no database)
- [ ] `price_cents % tick_size_cents == 0`
- [ ] `qty % lot_size == 0` and `qty > 0`
- [ ] Price within `reference_price_cents ± price_band_pct`
- [ ] `Price` present for Limit, absent for Market
- [ ] Duplicate `ClOrdID` for this session and business date
- [ ] Each rejection maps to a specific `OrdRejReason` — never a bare "rejected"

### 3. Translation
- [ ] `NewOrderSingle(D)` → engine `NewOrder`
- [ ] `OrderCancelRequest(F)` → engine `Cancel`
- [ ] Engine `Trade`/`Accepted`/`Rejected` → `ExecutionReport(8)` with the right `ExecType`
      and `OrdStatus`, running `CumQty`/`LeavesQty`/`AvgPx`
- [ ] `LastLiquidityInd(851)` set correctly — the fee schedule depends on maker vs taker
- [ ] Cancel rejections → `OrderCancelReject(9)`, not a session-level reject
- [ ] **An execution report goes only to the session that owns the order.** Getting this
      wrong leaks one participant's activity to another.

### 4. Persistence
- [ ] Own database and migrations: `fix_sessions` (seq numbers), `fix_outbound_store`
- [ ] Sequence numbers survive a restart

### 5. Tests
- [ ] Each validation rule rejects with the right reason
- [ ] Two sessions trade against each other; each sees only its own reports
- [ ] Kill the gateway mid-session; on restart the client's resend recovers cleanly

## Done when

A QuickFIX client and the broker's TypeScript initiator can both log on, trade against
each other through the book, and recover from a mid-session kill.
