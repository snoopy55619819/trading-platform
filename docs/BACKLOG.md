# Backlog

Possible next tasks after the MVP (milestones 0 to 8). Pick any; none depends on another
unless it says so. Bigger items get planned (endpoints, decisions) before they are built, the
way M8 was.

## Small follow-ups

- [x] **README "Running it" rewrite.** It described milestone 2; now it is built around
      `pnpm dev`, with each service's own run section kept for working on one alone.
- [x] **Chart: more dynamic.** The candle interval on the chart, zoom buttons for the
      time range shown, and a legend with the hovered candle's open, high, low, close and
      volume.
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
- [ ] **Open the guide on a first visit.** Show "How it works?" (ADR 0007) once on a new
      account's first sign-in, with a way to not see it again.
- [ ] **"See what just happened" after a fill.** A link on the fill confirmation that opens
      the guide's "Placing a trade" tab, so the steps follow the order just placed.
- [ ] **"Synthetic, no real money" banner.** A small, always-visible note in the web app so
      nobody visiting a public instance mistakes it for a real broker.
- [ ] **"Try it" button.** One click on the sign-in page creates a throwaway account with
      funds already in it, so a visitor can place an order in seconds without signing up.
      Throwaway accounts would need cleaning up, and fit with the public-instance limits.
- [ ] **QuickFIX conformance in CI.** Run `exchange-alpha/conformance/run.sh` in the `ci`
      workflow as well as the unit tests. It needs Go and the exchange's database, and takes
      longer, so it could run on merges to `main` only.
- [ ] **Limits for a public instance.** Rate limits on sign-up and sign-in, and a cap on
      "Add funds" (per deposit and per account), since anyone can open an account.
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

## News

- [ ] **A newswire.** A new participant that invents headlines about the listed companies;
      the simulator trades on them (a new price level and a few minutes of busier trading)
      and the broker stores them and shows them in a News panel and on the chart. Decided in
      [ADR 0006](adr/0006-news-from-a-newswire-participant.md); planned in stages in
      [`participants/newswire/TODO.md`](../participants/newswire/TODO.md).

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
- [ ] **Closer to real market speed.** At `SIM_ACTIVITY=1` the simulator sends about 18
      orders and cancels a second across 10 symbols, about 0.2 to 0.4 trades a second per
      symbol: roughly a quiet to typical mid-cap stock. Busy large caps would be about 5 to
      10 times that, mega caps like AAPL 50 to 100 times, and the whole US market (millions
      of messages a second at peaks) is out of reach for this design. `SIM_ACTIVITY` alone
      will not get there: it only scales the takers, and `SIM_MAX_ORDERS_PER_SEC` caps the
      simulator at 40 orders a second. A 5 to 10 times step means raising that cap and
      watching what gives first: the journal's size, the simulator's single FIX session,
      market-data writing every trade to Postgres (see ClickHouse below), and the server's
      CPU (2 vCPU; above 20% sustained costs extra). The matching engine itself benchmarks
      at about 690,000 commands a second, so it is not the limit. Doubles as a load test of
      the whole pipeline; real markets are also bursty (the open, the close, news), which a
      steady rate does not show.
- [ ] **Calmer market makers.** 95% of the exchange's orders are market maker quotes
      cancelled within seconds, replaced each time fair value moves. Wider tolerance before
      re-quoting would cut orders per trade, and with them the journal (about 120 MB a day
      even at `SIM_ACTIVITY=0.2`), disk and CPU, without making the market less lively.
      Check that spreads stay sane (ADR 0005).
- [ ] **Tick retention without losing data.** market-data keeps every trade in `ticks`
      forever: about 13 MB a day at the simulator's default activity, so years before a 30 GB
      disk fills. Only the latest trades are read (`GET /trades`); charts use candles, which
      stay forever either way. Before it matters, choose a way to move old ticks rather than
      delete them: monthly partitions archived to S3 as compressed files, or ClickHouse
      (above), whose column storage compresses this kind of data about 10×. Until then, a
      disk-usage alert on the server is enough.
- [ ] **Observability.** OpenTelemetry traces end to end, Prometheus and Grafana, latency
      histograms: one trace from a browser click through FIX and matching to settlement.
- [ ] **Chaos and performance.** Kill each service mid-flight and assert no lost, duplicated
      or double-executed orders; engine throughput benchmarks.
- [ ] **Surveillance.** Wash-trade, spoofing and layering detection, plus simulator agents
      that deliberately commit them.
- [ ] **Richer order types.** Stop, iceberg, post-only, midpoint peg; circuit breakers on
      top of the existing price bands.
