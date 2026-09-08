# trading-platform/

End-to-end simulation of the equities trading lifecycle. Entirely synthetic — no real market
data, no real money. Built as a learning project: the point is the systems architecture, not the
UI. See `PLAN.md` for the full architecture and milestone breakdown; read it before making
structural decisions.

## Stack

- **Rust** — the exchange only (`services/exchange/`, a cargo workspace of four crates).
  Chosen for the in-memory hot path, no GC pauses, and byte-level FIX parsing.
- **TypeScript** — everything else. Node + pnpm workspaces.
- **Postgres** — the only database in v1. ClickHouse migration is a post-MVP milestone.
- **FIX 4.4** — hand-rolled subset between the OMS (TS initiator) and the exchange gateway
  (Rust acceptor). Two independent implementations sharing only `contracts/fix/`.

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

The most common way to get this architecture wrong is to treat it as one pipeline. It isn't:

- **Order plane** — authenticated, request/response, per-client, FIX-shaped.
- **Market data plane** — public, broadcast, sequenced, fanned out to everyone.

Live prices and the order book in the UI come from the *second* plane. That data never travels
back up the order path.

## Working here

- Milestones are independently workable — see `PLAN.md` Part 7. Each has a concrete done-test.
- Empty directories carry a `.gitkeep` only because git will not track them otherwise. As soon as
  a directory gains a real file, delete its `.gitkeep` in the same change — it has done its job.
- ADRs go in `docs/adr/`. Record the *why*, especially for anything that touches the conventions
  above.
- FIX conformance is tested against QuickFIX, not just against our own initiator. Two of our own
  implementations agreeing proves less than one agreeing with a third party.
