# Backlog

Possible next tasks after the MVP (milestones 0 to 8). Pick any; none depends on another
unless it says so. Bigger items get planned (endpoints, decisions) before they are built, the
way M8 was.

## Small follow-ups

- [x] **README "Running it" rewrite.** It described milestone 2; now it is built around
      `pnpm dev`, with each service's own run section kept for working on one alone.
- [ ] **Chart: more dynamic.** Show the candle interval on the chart, zoom buttons for the
      time range shown, and a legend with the hovered candle's open, high, low, close and
      volume. *(in progress)*
- [ ] **Stay signed in across backend restarts.** Sessions live in the backend's memory, so
      a restart signs everyone out. Store them in the backend's database (hashed tokens,
      an expiry), keeping `sessionStorage` on the client.
- [ ] **P&L for the day.** Needs the account's value at the start of the business day: a
      backend snapshot at the 21:00 UTC roll, then the web shows today's change beside the
      unrealized and realized P&L it has now.
- [ ] **Fees in the web's estimates.** The ticket leaves fees out because the web does not
      know the venue's fee schedule. Put maker and taker fees on `GET /symbols` (or a
      venue endpoint) and include the worst case in the estimate and buying-power hint.
- [ ] **Order history paging.** The backend returns the latest 100 orders. Add a cursor
      (`?before=<orderId>`) and "load more" in History when 100 is not enough.
- [ ] **Phone views for Pro and Active tables.** On a phone their positions and orders
      tables scroll sideways inside the panel; Calm's list variant could become the phone
      view for every style.

## The layout editor

Layouts are already data (`broker/web/src/layout/layouts.ts`), in the shape grid editors use.

- [ ] Save a user's layout per style with the account (a backend table, like the
      watchlist); on load, a layout that fails `validateLayout` falls back to the default.
- [ ] An edit mode: drag to move, drag a corner to resize, add a panel from a list, remove
      one, reset to the default.
- [ ] Per-panel settings through `props`: a second chart on another symbol or interval.

## Post-MVP roadmap (`PLAN.md` Part 8)

In the plan's suggested order of value.

- [ ] **Post-trade plane.** Clearing (novation and end-of-day multilateral netting), a
      custodian (book entry, delivery versus payment), a settlement bank, and a clock for a
      real T+1. Auto-settle becomes clock-driven; `STREET_CONTRA` becomes
      `CLEARING_RECEIVABLE`. The differentiator: few side projects have a central
      counterparty.
- [ ] **Redpanda bus.** Replace direct connections where fan-out is now real (fills to the
      ledger, clearing and surveillance). Replay-driven state rebuild.
- [ ] **ClickHouse migration.** Move `ticks` and `bars` off Postgres, with a measured before
      and after.
- [ ] **Observability.** OpenTelemetry traces end to end, Prometheus and Grafana, latency
      histograms: one trace from a browser click through FIX and matching to settlement.
- [ ] **Chaos and performance.** Kill each service mid-flight and assert no lost, duplicated
      or double-executed orders; engine throughput benchmarks.
- [ ] **Surveillance.** Wash-trade, spoofing and layering detection, plus simulator agents
      that deliberately commit them.
- [ ] **Richer order types.** Stop, iceberg, post-only, midpoint peg; circuit breakers on
      top of the existing price bands.
