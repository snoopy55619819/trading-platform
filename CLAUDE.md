# trading-platform/

End-to-end simulation of the equities trading lifecycle. Entirely synthetic — no real market
data, no real money. Built as a learning project: the point is the systems architecture, not the
UI. See `PLAN.md` for the full architecture and milestone breakdown; read it before making
structural decisions.

## Layout: organised by company

Each top-level folder is an independent business. They share no code, no build and no
contracts directory. This is the single most important structural fact about the repo.

- `exchange-alpha/` — Alpha Exchange. **Rust.** `spec/` is what it publishes; `crates/` is
  private implementation. Chosen for the in-memory hot path and byte-level FIX parsing.
- `broker/` — a broker-dealer. **TypeScript.** Three deployables, nothing shared between
  them — no workspace, no shared package, no shared database:
  - `backend/` — one process: `api` + `oms` + `ledger` + `fix`. They share a process
    because they share a transaction; splitting them makes a buying-power check
    non-atomic for no benefit. Single-instance: a FIX session is a stateful singleton.
  - `market-data/` — separate on technical grounds: continuous write-heavy ingest, no
    transactional coupling, its own database, headed for a columnar store. Owns live
    WebSocket fanout *and* chart history.
  - `web/` — a static bundle. Talks to `backend` for auth and orders, to `market-data`
    for prices, and joins them itself.

  Each vendors its own copy of the exchange spec under `<deployable>/vendor/`.
  **Do not introduce a shared package between them** — it would quietly make both sides
  TypeScript forever, and the point of the split is that either could be any stack.
  **Do not split a backend module into a service** without a technical reason; "it feels
  like a microservice" is not one.

- `participants/` — other trading firms. **TypeScript.** Connects over the same public
  FIX session any client uses.

Cross-company: the exchange **publishes** a spec; consumers vendor a copy and implement
against it. Never reach across a company boundary to import a file — sync it, stamp the
version, and let `spec:check` tell you when it goes stale.

## Stack
- **Postgres** — **a database per deployable, never shared.** No role holds any
  grant on another's, so a cross-service query is impossible rather than merely
  discouraged. Each owns its own migrations and migration tooling; nothing coordinates.
  There is no shared `infra/` directory — infrastructure belongs to whoever owns it.
  Today only `broker/backend` has a database. Alpha Exchange gets its own at M2 (FIX
  session state) and `market-data` at M7 — neither may add a schema to the backend's.
  One container each is fine; splitting onto separate hosts later costs only a
  connection string, since nothing else couples to where Postgres lives.
- **No protobuf inside the broker.** Types that never cross a wire are plain TypeScript
  inside whichever service owns them (`backend/src/domain/`). Protobuf is for real wire
  formats only — currently just the exchange's published market data schema.
- **No build step, anywhere.** Node runs `.ts` directly by stripping types. This holds
  only because nothing is consumed as a *dependency*: Node refuses to strip types for
  anything resolving inside `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is exactly where a deploy bundle
  puts a workspace package. If you ever add a package consumed as a dependency, it must
  be compiled to JavaScript first — which is a good reason not to add one.
- **FIX 4.4** — hand-rolled subset between the broker app (TS initiator) and the exchange gateway
  (Rust acceptor). Two independent implementations sharing only `exchange-alpha/spec/fix44.xml`
  and the broker's vendored copy of it.

## Non-negotiable conventions

These are architectural commitments, not preferences. Breaking them causes rewrites.

- **No floats for money, ever.** Prices are integer ticks; cash is integer minor units (cents).
- **Positions and cash are derived from ledger journal lines**, never stored as an incremented
  counter. Every journal entry balances: `SUM(debit) = SUM(credit)` per entry, per asset.
- **The matching engine has no database.** State is RAM; durability is an append-only journal;
  recovery is replay. Journal replay must reproduce a byte-identical book.
- **The simulator gets no backdoor.** Its agents connect over the same public FIX path a real
  client uses. That's what makes it a valid test rather than a cheat.
- **`venue` is on every order and fill**, always `"ALPHA"` in v1. Adding Exchange Beta later is
  data, not a migration.
- **Settled and unsettled are separate ledger accounts** even though v1 auto-settles instantly.
  Adding real T+1 later changes *when* the settle job fires, not the schema.
- **Market data is sequenced.** Every feed message carries a `feed_seq`; subscribers detect gaps
  and recover via snapshot + replay.

## Two data planes

**The canonical architecture diagrams live in `docs/architecture/`** (`current-plan.html`,
`ideal-end-state.html`), embedded in the README as SVGs. Edit the HTML, then regenerate with
`node docs/architecture/export-svg.mjs`. Keep them current: they are the first thing anyone
reads, and the picture to reason from
before changing how services talk to each other.

The rule it encodes: this is not one pipeline, it is two independent planes.

- **Order plane** — private, authenticated, request/response, one client's data.
  `web → api → oms → gateway → matching-engine`, execution reports back up.
- **Market data plane** — public, broadcast, sequenced, anonymous.
  `matching-engine → md-publisher → everyone`.

Live prices and the order book in the UI come from the *second* plane; that data never
travels back up the order path. `market-data` owns both live fanout and history — it subscribes
to the same feed and persists it. A fill you caused reaches you twice: privately as an
execution report, publicly as an anonymous print.

## Working here

- Milestones are independently workable — see `PLAN.md` Part 7. Each has a concrete done-test.
- Empty directories carry a `.gitkeep` only because git will not track them otherwise. As soon as
  a directory gains a real file, delete its `.gitkeep` in the same change — it has done its job.
- **`docs/DECISIONS.md`** holds the long-form version of the conventions above — money
  representation, identifier formats, enum rules, sequencing, the two planes, the ledger,
  and how specs are published and vendored. Read it before changing anything structural.
- ADRs go in `docs/adr/`. Record the *why*, especially for anything that touches the
  conventions above.
- FIX conformance is tested against QuickFIX, not just against our own initiator. Two of our own
  implementations agreeing proves less than one agreeing with a third party.
