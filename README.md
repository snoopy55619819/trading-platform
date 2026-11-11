# trading-platform

An end-to-end simulation of the equities trading lifecycle, built to learn how market
infrastructure actually fits together. Entirely synthetic — no real market data, no real money.

See [PLAN.md](PLAN.md) for the architecture and milestone breakdown.

## Organised by company, not by service

The top level mirrors the real world: **each folder is a business that would exist
independently.** They share no code, no build, and no contracts directory.

```
exchange-alpha/   Alpha Exchange        (Rust)  — publishes spec/, everything else is private
broker/           A broker-dealer       (TS)    — backend, market-data, web
                                                  three deployables, nothing shared
participants/     Other trading firms   (TS)    — the simulated market
```

Cross-company interfaces work the way they do in the industry: **the exchange publishes a
spec, and everyone else implements against it.** Nasdaq doesn't co-own a schema repo with
Schwab — it publishes a FIX spec and firms build to it.

The exchange publishes `fix44.xml`, `marketdata.proto` and `listings.json` in
`exchange-alpha/spec/`. Each consumer copies only the files it uses into its own
`vendor/exchange-alpha/`, stamped with the spec version:

| Consumer | Vendors |
|---|---|
| `broker/backend` | `fix44.xml`, `listings.json` |
| `broker/market-data` | `marketdata.proto`, `listings.json` |

`pnpm spec:sync` updates the copies on purpose; `pnpm spec:check` fails when a copy falls
behind. A stale copy is not a repo problem: it is integration work, and handling it is part
of what this project is for.

There are no shared packages, even between the broker's own services. That is what keeps
each of them free to be rewritten in another language.

## Architecture diagrams

### Current plan (MVP)

What we are building through milestone 8. To keep scope manageable the broker runs as one
backend process and the exchange as one binary. Every box shows the milestone that builds it;
the ones tagged BUILT exist today.

![Current MVP plan: broker backend and exchange binary, connected by FIX for orders and WebSocket for market data](docs/architecture/current-plan.svg)

### Ideal end state

Every service split the way the industry splits it, with nothing cut for scope. **SPLIT**
boxes were modules inside a merged process in the MVP; **dashed** boxes and dotted lines were
cut from the MVP entirely. Post-trade (clearing, custody, settlement) appears as a third plane.

![Ideal end state: broker, two exchanges, market infrastructure and simulation across order, market data and post-trade planes](docs/architecture/ideal-end-state.svg)

The numbered badges are explained in each diagram's legend: open
[`current-plan.html`](docs/architecture/current-plan.html) or
[`ideal-end-state.html`](docs/architecture/ideal-end-state.html) for the full table and a
light/dark toggle. After editing a diagram, regenerate the images with
`node docs/architecture/export-svg.mjs`.

## How it fits together

The single most important structural fact: **this is not one pipeline, it is two independent
planes.** The same match reaches you twice, by two different routes, carrying two different
things — privately as your execution report, publicly as an anonymous print on the tape.

The diagrams above show both planes: blue for orders, orange for market data.

`web` talks to **two** services and joins them itself: positions from `backend`, prices from
`market-data`. That is what keeps the backend free of any market-data dependency.

**Where the boundaries are, and why.** The company boundary is real: two businesses, a
network between them, FIX as the contract. Inside the broker, `api`/`oms`/`ledger` are *not*
separate — splitting them would make a buying-power check non-transactional in exchange for
nothing. `market-data` is separate on technical grounds: different workload, different
database, no transactional coupling.

**`fix-core` is a library, not a server:** the FIX codec plus the session state machine.
The gateway links it in, and the backend links its own initiator against the same published
dictionary. It has never heard of an order book.

**What the two planes must never share:** `TradePrint` has no field for an account or a
client order id — structurally, not by convention. Leaking one onto the public feed would be
a correctness bug, so the schema makes it impossible to write.

## Running it

**What exists today (milestone 2):** Alpha Exchange is on the network. Its FIX 4.4 gateway
accepts orders from any FIX client, matches them, and survives being killed. The broker's
database exists too. `backend`, `market-data`, `web` and `simulator` are still scaffolding,
so for now you talk to the exchange with a FIX client of your own, or the QuickFIX
conformance client.

### First time

```bash
cd exchange-alpha && cargo build
```

```bash
cd broker/backend && pnpm install
```

```bash
cd broker/market-data && pnpm install
```

Each installs independently — there is no workspace, and no root install.

### Start the database

```bash
docker compose -f broker/compose.yml up -d --wait
```

```bash
cd broker/backend && pnpm db:migrate && pnpm db:seed
```

`--wait` blocks until the healthcheck passes, so the migration never races the container.

### Look at the database

No local `psql` needed — go through the container:

```bash
docker compose -f broker/compose.yml exec broker-postgres psql -U broker -d broker
```

If you do have `psql` locally (`brew install libpq`), or want to point a GUI at it
(TablePlus, DBeaver, DataGrip):

```
postgres://broker:broker@127.0.0.1:5432/broker
```

Useful once you are in:

| | |
|---|---|
| `\dn` | list schemas — you should see `broker` |
| `\dt broker.*` | its tables: `securities`, `schema_migrations` |
| `\d broker.securities` | columns **and the CHECK constraints** |
| `SELECT * FROM broker.securities;` | the seeded instruments |
| `SELECT * FROM broker.schema_migrations;` | what has been applied, and when |

### Run the exchange

Alpha Exchange has its own database (port 5433), separate from the broker's:

```bash
docker compose -f exchange-alpha/compose.yml up -d --wait
```

```bash
cd exchange-alpha && cargo run -p gateway
```

It listens for FIX 4.4 on `127.0.0.1:9878`, publishes market data over WebSocket on
`127.0.0.1:9879`, and journals to `exchange-alpha/data/`. CompIDs allowed to log on:
`BROKER`, `SIM`, `QFGO1`, `QFGO2` (set `ALPHA_COMP_IDS` to change).

**Watch the feed**: a live depth ladder for one symbol, rebuilt from the public feed alone.
Kill it and start it again and it carries on from a snapshot with no gap. `--log` prints
each message with its sequence numbers instead:

```bash
cd exchange-alpha && cargo run -p md-publisher --bin md-watch -- ACME
```

**Conformance against QuickFIX**, an independent FIX engine loading the same published
spec. Two sessions trade, then the gateway is killed with `kill -9` and restarted, and a fill
that happened while a client was away must reach it by resend:

```bash
cd exchange-alpha && ./conformance/run.sh
```

### Bring the market to life

Simulated trading firms (market makers, noise, momentum and mean-reversion traders) that
connect like any other client: one FIX session, the public feed, no backdoor. With the
exchange running:

```bash
cd participants/simulator && pnpm install && pnpm proto:gen && pnpm start
```

Then watch a symbol with `md-watch` as above. `SIM_SPEED=20` runs prices twenty times
faster than the clock; `SIM_ACTIVITY=0.2` makes a quiet market for a deployed instance.
Ctrl-C cancels everything the simulator has resting.

### Run the matching engine (no network)

A walkthrough of every matching rule (price-time priority, walking the book, IOC, FOK,
self-trade prevention, cancels), with commentary:

```bash
cd exchange-alpha && cargo run -p matching-engine -- crates/matching-engine/scenarios/demo.txt
```

Or trade interactively. With `--journal`, quit and restart and the book is exactly as you
left it:

```bash
cd exchange-alpha && cargo run -p matching-engine -- --journal /tmp/alpha.journal
```

Tests for the whole exchange (matching, FIX, gateway, market data) and the matching latency
benchmark:

```bash
cd exchange-alpha && cargo test --workspace && cargo bench -p matching-engine
```

### Shortcuts from the repo root

| | |
|---|---|
| `pnpm db:up` / `pnpm db:down` | start / stop Postgres |
| `pnpm db:reset` | wipe the volume, re-migrate, re-seed |
| `pnpm spec:check` | fail if any vendored venue spec is stale |
| `pnpm backend <script>` | run a script inside `broker/backend` |

These are conveniences only. Everything they do you can do from inside the folder itself —
no deployable depends on the repo root to build, run or deploy.

## Working on it

Each service carries its own **`TODO.md`** — a checklist plus the inputs and outputs it is
responsible for. Start there rather than from `PLAN.md`, which is the roadmap rather than
the working document.

| Milestone | Service | Checklist |
|---|---|---|
| M1 | matching engine | [`exchange-alpha/crates/matching-engine/TODO.md`](exchange-alpha/crates/matching-engine/TODO.md) |
| M2 | FIX codec + session | [`exchange-alpha/crates/fix-core/TODO.md`](exchange-alpha/crates/fix-core/TODO.md) |
| M2 | exchange gateway | [`exchange-alpha/crates/gateway/TODO.md`](exchange-alpha/crates/gateway/TODO.md) |
| M3 | market data feed | [`exchange-alpha/crates/md-publisher/TODO.md`](exchange-alpha/crates/md-publisher/TODO.md) |
| M4 | simulated participants | [`participants/simulator/TODO.md`](participants/simulator/TODO.md) |
| M5–M6 | broker backend | [`broker/backend/TODO.md`](broker/backend/TODO.md) |
| M7 | broker market data | [`broker/market-data/TODO.md`](broker/market-data/TODO.md) |
| M8 | client | [`broker/web/TODO.md`](broker/web/TODO.md) |

Conventions that apply everywhere are in [`docs/DECISIONS.md`](docs/DECISIONS.md); the
short version is in [`CLAUDE.md`](CLAUDE.md).

## Status

**Milestone 4, simulated participants: complete.** The market is alive. A TypeScript
simulator, sharing no code with the exchange, logs on over its own FIX 4.4 initiator and
reads the public feed: market makers quote ten books around a hidden fair value (geometric
Brownian motion with news jumps), skew to shed inventory and pull quotes on jumps; noise,
momentum and mean-reversion traders take liquidity. Behaviour runs against the real
exchange, with an independent recorder on the feed, found and fixed books going one-sided
and market makers overshooting their inventory limits. Zero rejects and zero feed gaps
across thousands of orders.

**Milestone 3, market data: complete.** The public plane. Every book change and trade goes
out over WebSocket as protobuf, per the published `marketdata.proto`, with no field that
could identify a participant. Each message carries a venue-wide `feed_seq` and a
per-symbol `symbol_seq` (ADR 0001); a subscriber that sees a gap asks for a fresh
snapshot. Slow subscribers are disconnected rather than allowed to stall the feed. The
feed is rebuilt from the journal on restart, so its sequence numbers survive a `kill -9`.
A property test drives random order flow through the real engine and checks that a
subscriber joining at any point rebuilds the engine's exact book from the feed alone. 106
tests across the exchange.

**Milestone 2, FIX 4.4: complete.** Alpha Exchange speaks FIX over TCP. `fix-core` is a
hand-written codec, data dictionary and session state machine (logon, heartbeats, sequence
numbers, gap detection, resend); the `gateway` validates every order against the venue's
rules before the engine sees it and sends each side of a trade only its own execution
report. Sequence numbers live in the exchange's own Postgres and survive restarts.
Conformance-tested against **QuickFIX/Go**, which trades through the book, survives the
gateway being SIGKILLed, and recovers a missed fill by resend.

Next: **Milestone 5, the broker backend** (`broker/backend`): orders, risk checks and the
double-entry ledger.
