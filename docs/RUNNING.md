# Running the trading platform

Everything for running it locally: first-time setup, the one command that starts it all,
what to do when something goes wrong, how to run one piece on its own, and the shortcuts
from the repo root. The overview is in the [README](../README.md).

One command runs the whole stack: three databases, the exchange, the simulated market, the
broker's backend and market-data, and the web client. You trade in a browser at
http://localhost:5173.

## Quick start

**Prerequisites:**

| | |
|---|---|
| Docker | the three Postgres databases run in containers |
| Rust 1.98 or later | the exchange (`rust-version` in `exchange-alpha/Cargo.toml`) |
| Node 26 | every TypeScript service (`engines` in each `package.json`; `.nvmrc` pins 26.8.1, so `nvm use` picks it) |
| pnpm | installs and scripts |
| `buf` | generates the market data types from the exchange's published `.proto` |

**First time.** Each deployable installs on its own. There is no workspace and no root
install:

```bash
nvm use
pnpm backend install && pnpm market-data install && pnpm web install && pnpm simulator install
```

The simulator and market-data read the exchange's feed through generated code, which is
never committed:

```bash
pnpm simulator proto:gen && pnpm market-data proto:gen
```

Start the broker's two databases, then create their schemas and seed the instruments:

```bash
pnpm db:up && pnpm backend db:migrate && pnpm backend db:seed && pnpm market-data db:migrate
```

The exchange's database needs no migration step: `pnpm dev` starts it and the gateway sets
up its own tables.

**Every time:**

```bash
pnpm dev
```

The first run compiles the exchange, so give it a minute. Ctrl-C stops every process; the
databases keep running.

**In the browser**, open http://localhost:5173:

1. Choose "New here? Open an account" and sign up with any email and password.
2. Click **Add funds** at the top of the activity panel. A new account has no cash.
3. Pick a symbol, enter a quantity in the order ticket (or click a price in the book), and
   confirm. The fill shows in the blotter and your holdings update.

## When something goes wrong

- **A port is already in use.** Each process binds a fixed port: FIX 9878, the exchange's
  feed 9879, backend 8080, market-data 8081, web 5173, Postgres 5432, 5433 and 5434. The web
  client will not move to another port, because the backend only allows that origin. Find
  the old process with `lsof -i :<port>` and stop it.
- **The gateway cannot reach its database.** Start it with `pnpm exchange:db`.
- **Start the databases again from empty.** `pnpm db:reset` deletes the broker's two
  volumes, migrates and re-seeds. Every account, order and candle is lost. It does not touch
  the exchange's database.
- **Start the exchange again from empty.** Stop `pnpm dev` and delete the files in
  `exchange-alpha/data/`, then `pnpm db:reset` as well: the broker's records of orders
  must not outlive the exchange's. The gateway refuses to start on an old single
  `alpha.journal` from before business days, for the same reason.
- **A spec changed under you.** `pnpm spec:check` names any vendored copy that is behind;
  `pnpm spec:sync` updates them, then run `proto:gen` again.

## Working on one piece alone

Each service also runs by itself, from its own folder. The commands below assume the
first-time setup above.

### The database

`psql` without installing it, through the container:

```bash
docker compose -f broker/compose.yml exec broker-postgres psql -U broker -d broker
```

If you do have `psql` locally (`brew install libpq`), or want to point a GUI at it
(TablePlus, DBeaver, DataGrip):

```
postgres://broker:broker@127.0.0.1:5432/broker
postgres://market_data:market_data@127.0.0.1:5434/market_data
postgres://exchange_alpha:exchange_alpha@127.0.0.1:5433/exchange_alpha
```

Useful once you are in the broker's:

| | |
|---|---|
| `\dn` | list schemas: you should see `broker` |
| `\dt broker.*` | its tables: users, accounts, orders, fills, the ledger's journal, and more |
| `\d broker.securities` | columns **and the CHECK constraints** |
| `SELECT * FROM broker.securities;` | the seeded instruments |
| `SELECT * FROM broker.schema_migrations;` | what has been applied, and when |

### The exchange

Alpha Exchange has its own database (port 5433), separate from the broker's:

```bash
pnpm exchange:db
```

```bash
cd exchange-alpha && cargo run -p gateway
```

It listens for FIX 4.4 on `127.0.0.1:9878`, publishes market data over WebSocket on
`127.0.0.1:9879`, and keeps each business day's snapshot and journal in
`exchange-alpha/data/`. CompIDs allowed to log on: `BROKER`, `SIM`, `QFGO1`, `QFGO2` (set
`ALPHA_COMP_IDS` to change). The other settings are listed at the top of
`exchange-alpha/crates/gateway/src/main.rs`.

The business day closes at 21:00 UTC: day orders expire and a new snapshot and journal
begin. To watch a roll sooner, set `ALPHA_ROLL_EVERY_SECS` on the gateway, and
`SIM_SESSION_RESET_EVERY_SECS` for the simulator's daily session reset.

**Watch the feed**: a live depth ladder for one symbol, rebuilt from the public feed alone.
Kill it and start it again and it carries on from a snapshot with no gap. `--log` prints
each message with its sequence numbers instead:

```bash
cd exchange-alpha && cargo run -p md-publisher --bin md-watch -- ACME
```

**Conformance against QuickFIX**, an independent FIX engine loading the same published
spec. Two sessions trade, then the gateway is killed with `kill -9` and restarted, and a fill
that happened while a client was away must reach it by resend. It needs Go, the exchange's
database, and port 9878 free, so stop `pnpm dev` first. It builds and starts its own
gateway on a fresh data directory, and it drops the exchange database's FIX session tables
before it starts:

```bash
pnpm exchange:conformance
```

### The simulated market

Simulated trading firms (market makers, noise, momentum and mean-reversion traders) that
connect like any other client: one FIX session, the public feed, no backdoor. With the
exchange running:

```bash
cd participants/simulator && pnpm start
```

Then watch a symbol with `md-watch` as above. `SIM_SPEED=20` runs prices twenty times
faster than the clock; `SIM_ACTIVITY=0.2` makes a quiet market for a deployed instance.
Ctrl-C cancels everything the simulator has resting.

### The broker's backend

An HTTP API, the OMS with pre-trade risk, the ledger, and its own FIX connection to the
exchange. With the exchange running (and ideally the simulator, so there is something to
trade against):

```bash
cd broker/backend && pnpm start
```

Every endpoint is listed at the top of `broker/backend/src/api/server.ts`. With `curl`:
sign up, log in, fund the account, buy, and look at the result.

```bash
curl -s -X POST localhost:8080/users -d '{"email":"ada@example.com","password":"correct horse"}'
```

```bash
TOKEN=$(curl -s -X POST localhost:8080/sessions -d '{"email":"ada@example.com","password":"correct horse"}' | jq -r .token)
```

```bash
curl -s -X POST localhost:8080/deposits -H "Authorization: Bearer $TOKEN" -d '{"amountCents":5000000}'
```

```bash
curl -s -X POST localhost:8080/orders -H "Authorization: Bearer $TOKEN" -d '{"clientOrderId":"first","symbol":"ACME","side":"BUY","orderType":"MARKET","timeInForce":"IOC","qty":100}'
```

```bash
curl -s localhost:8080/positions -H "Authorization: Bearer $TOKEN"
```

`GET /status` says whether the FIX session to the exchange is up.

### The broker's market data

Live prices for browsers and chart history, from the exchange's public feed. With the
exchange running:

```bash
cd broker/market-data && pnpm start
```

```bash
curl -s "localhost:8081/history?symbol=ACME&interval=1m"
curl -s "localhost:8081/trades?symbol=ACME&limit=10"
curl -s localhost:8081/health
```

Browsers subscribe on `ws://localhost:8081/live` with `{"subscribe": ["ACME"]}`.

### The web client

The browser client, built with Vite. With the backend and market-data running:

```bash
cd broker/web && pnpm dev
```

It serves on `http://localhost:5173`, the origin the backend allows by default
(`BROKER_WEB_ORIGIN` on the backend changes that). Point the client elsewhere at build time
with `VITE_BACKEND_URL` and `VITE_MARKET_DATA_URL`.

### The matching engine (no network)

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

### Tests

The whole exchange (matching, FIX, gateway, market data), then the matching latency
benchmark:

```bash
pnpm exchange:test && cd exchange-alpha && cargo bench -p matching-engine
```

Each TypeScript deployable runs its own with `pnpm test` (and `pnpm typecheck`) from its
folder.

## Shortcuts from the repo root

| | |
|---|---|
| `pnpm dev` | everything at once, on http://localhost:5173. Ctrl-C stops it all (the databases keep running) |
| `pnpm db:up` / `pnpm db:down` | start / stop the broker's two databases |
| `pnpm db:reset` | wipe the broker's databases, re-migrate, re-seed |
| `pnpm exchange:db` | start the exchange's database |
| `pnpm exchange:run` / `exchange:build` / `exchange:test` | run, build or test the exchange |
| `pnpm exchange:conformance` | the QuickFIX conformance run |
| `pnpm spec:check` / `pnpm spec:sync` | find / update stale vendored copies of the exchange's spec |
| `pnpm backend <script>` | run a script inside `broker/backend`; likewise `market-data`, `web` and `simulator` |

These are conveniences only. Everything they do you can do from inside the folder itself:
no deployable depends on the repo root to build, run or deploy.
