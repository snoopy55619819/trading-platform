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
- `broker/` — a broker-dealer. **TypeScript.** `contracts/` is shared *within* the broker
  because those services are one team's codebase. `vendor/exchange-alpha/` is a copy of
  the exchange's published spec, version-stamped.
- `participants/` — other trading firms. **TypeScript.** Connects over the same public
  FIX session any client uses.

Cross-company: the exchange **publishes** a spec; consumers vendor a copy and implement
against it. Never reach across a company boundary to import a file — sync it, stamp the
version, and let `spec:check` tell you when it goes stale.

## Stack
- **Postgres** — one local container, one database. Each company owns its own schemas and
  runs its own migrations with its own tooling; nothing coordinates across companies.
- **FIX 4.4** — hand-rolled subset between the OMS (TS initiator) and the exchange gateway
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

**The canonical architecture diagram lives in [README.md](README.md#how-it-fits-together).**
Keep it current — it is the first thing anyone reads, and it is the picture to reason from
before changing how services talk to each other.

The rule it encodes: this is not one pipeline, it is two independent planes.

- **Order plane** — private, authenticated, request/response, one client's data.
  `web → api → oms → gateway → matching-engine`, execution reports back up.
- **Market data plane** — public, broadcast, sequenced, anonymous.
  `matching-engine → md-publisher → everyone`.

Live prices and the order book in the UI come from the *second* plane; that data never
travels back up the order path. `tick-store` is **history**, not live prices — it subscribes
to the same feed and persists it. A fill you caused reaches you twice: privately as an
execution report, publicly as an anonymous print.

## Working here

- Milestones are independently workable — see `PLAN.md` Part 7. Each has a concrete done-test.
- Empty directories carry a `.gitkeep` only because git will not track them otherwise. As soon as
  a directory gains a real file, delete its `.gitkeep` in the same change — it has done its job.
- ADRs go in `docs/adr/`. Record the *why*, especially for anything that touches the conventions
  above.
- FIX conformance is tested against QuickFIX, not just against our own initiator. Two of our own
  implementations agreeing proves less than one agreeing with a third party.
