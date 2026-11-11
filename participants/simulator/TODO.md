# market-simulator — Milestone 4

**Makes the market look alive when nobody is using the app.** Without it, v1 is an empty
book and a flat chart.

Status: **not started** · depends on: gateway (M2), md-publisher (M3)

## Inputs / outputs

| | |
|---|---|
| **In** | The public market data feed — agents watch the book like anyone else |
| **Out** | Orders over FIX, through the **same public gateway** a real client uses |
| **Owns** | Per-agent state in memory: fair value estimate, inventory, PnL, live quote ids |

**No backdoor into the engine.** The simulator is just more FIX clients. That is exactly
what makes it a valid test of the whole system rather than a rigged demo — and it means
the gateway is under continuous load from this milestone onward.

## Checklist

### 1. Plumbing
- [ ] Vendor the venue spec (uncomment this service in the sync script's consumers)
- [ ] FIX initiator — a TypeScript one, independent of the Rust acceptor
- [ ] Subscribe to the market data feed with gap detection
- [ ] Per-agent FIX sessions, or one session with distinct account ids — decide and note why

### 2. Price process
- [ ] Hidden fair value per symbol on a geometric Brownian motion, seeded from
      `reference_price_cents`
- [ ] Per-symbol drift and volatility (HELX should move far more than GRID)
- [ ] Occasional jumps — "news" — or charts look like noise around a flat line
- [ ] Diurnal multiplier on volume and volatility, so there are quiet and busy hours

### 3. Agents
- [ ] **Market maker** — quotes both sides around fair value; spread widens with
      volatility; **inventory skew** (long → shade quotes down to offload); pulls quotes on
      a large adverse move. This is the agent that creates liquidity; without it nothing
      else has anything to trade against.
- [ ] **Noise trader** — Poisson arrivals, random side, small market orders
- [ ] **Momentum** — chases short-term moves; creates trends
- [ ] **Mean reversion** — fades extremes; creates the pullbacks
- [ ] Global rate control, so you can dial total order volume down for a deployed instance

### 4. Behaviour checks
- [ ] The spread stays sane — it should not collapse to zero or blow out permanently
- [ ] Price wanders without exploding or flatlining over a long run
- [ ] Market makers end roughly flat rather than accumulating unbounded inventory
- [ ] The 1-minute chart looks like a real stock to the eye

## Done when

The book is alive 24/7 and the depth ladder and chart look like a real market.
