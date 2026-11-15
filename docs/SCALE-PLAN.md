# Scale plan: 500 to 1,000 transactions a second

The plan behind [ADR 0012](adr/0012-scaling-to-1000-transactions-a-second.md). The goal: the
platform handles 500 to 1,000 transactions a second (new orders and cancels the exchange
accepts), end to end, measured by a load test anyone can run; and the live market runs fast
enough that the order book, time and sales and chart visibly move. Each stage is one PR with
its load test numbers before and after.

## The metric

**Transactions a second:** `NewOrderSingle` and `OrderCancelRequest` messages the gateway
accepts and journals, per second. The journal holds every one, so it is counted exactly.
Reported with: trades a second, execution reports a second, feed messages a second, rejects,
throttling, feed gaps, and each process's CPU and memory.

Where it stands (from the journal on the live server):

| Simulator | Daily average | New York market hours |
|---|---|---|
| Activity 2 (`v0.5.4` to `v0.5.8`) | about 17 | about 25 |
| Activity 4 (`v0.5.9`, expected) | about 35 | about 50 |

## Stages

### 1. A load test, and the first real number

- [x] A script that runs the whole stack locally (exchange, simulator, broker, market-data,
      newswire) and steps the simulator's load up, a minute a step, holding the time-of-day
      curve flat so every step is comparable: `pnpm load-test` (`load-test/run.ts`,
      `SIM_FLAT_DAY`).
- [x] At each step: transactions, trades, execution reports and feed messages a second; each
      process's CPU and memory; rejects, feed gaps; how long an order takes from the
      simulator to the exchange's first answer (`ack p50`/`p99` in the simulator's status
      line).
- [x] It stops at the first step where something gives (a process at 90% of a core, the
      exchange falling behind, rejects, gaps, the market makers stopping, the answer's 99th
      percentile over 50 ms) and says which.
- [x] Results saved in `load-test/results/`, to compare later runs with.
- [x] Record the first number (below).

**First number (2026-11-15, an Apple M5 Pro laptop, everything local): handles about 70
transactions a second, limited by how long the exchange takes to answer.**

| Activity | Transactions/s | Trades/s | Answer p50 / p99 | Busiest process |
|---|---|---|---|---|
| 4 | 31 | 6 | 8 / 30 ms | exchange Postgres, 2% of a core |
| 16 | **69** | 24 | 19 / 42 ms | 3% |
| 32 | 111 | 46 | 27 / **60 ms** (stop) | gateway, 4% |
| 256 (past the limit) | 515 | 363 | 74 / 150 ms | gateway, 11% |
| 1024 (past the limit) | about 1,200, and no more | 164 | 2.2 s; the market makers stop | exchange Postgres, 18% |

(`load-test/results/2026-11-15-before.json`, and `-before-ceiling.json` for the run past the
latency limit.)

What it found:

- **Nothing is short of CPU.** At 1,200 a second the busiest process uses 18% of one core.
- **The limit is waiting, not work.** The gateway's core handles one message, then saves the
  FIX sessions to Postgres (a transaction, and one `INSERT` per outgoing message), then the
  next. Each message waits for the saves of every message before it: about 0.8 ms each, so
  answers slow as soon as messages arrive in bursts (the simulator sends every 250 ms) and
  nothing gets past about 1,200 messages a second. Turning off Postgres's commit flush
  changed nothing, so it is round trips, not the disk. This is stage 2, confirmed.
- **The simulator could not make the load at first:** each taker could send at most one
  order per symbol per 250 ms step, so it stopped at about 125 a second whatever the
  activity. Its noise traders now send as many as their rate calls for (a Poisson count;
  `rng.count`), the same as before at today's activity.
- Feed gaps, rejects and memory were fine at every step.

### 2. Batch the gateway's FIX session writes

The first bottleneck, confirmed by stage 1: a save after every message, and one `INSERT` into
`fix_outbound` per outgoing message.

- [ ] One multi-row insert (or `COPY`) per save, with the resend window's delete in the same
      transaction (ADR 0010).
- [ ] Optionally, for sessions that reset on every logon (the simulator), keep the window in
      memory only.
- [ ] Load test before and after.

### 3. Journal retention and size

At 500 to 1,000 a second the journal is 7 to 13.5 GB a day; seven days do not fit 30 GB.

- [ ] Keep one or two finished days locally instead of seven (`hosting/backup.sh`); S3 already
      keeps every day, compressed, for a year.
- [ ] If disk is still tight: batch the journal's writes (one system call per batch, not per
      command), then compress it as it is written, or a binary format (about 30 to 40 bytes a
      transaction instead of 156). Each its own decision.

### 4. Finished-order ids at scale

ADR 0011's compact entries are about 570 MB a day at 500 a second and 1.1 GB at 1,000: too much
for a 2 GB server at the top of the range.

- [ ] Measure the gateway's real peak at the rate stage 1 reaches.
- [ ] If it does not fit: an ADR choosing between checking ids against live orders only (Cboe,
      CME; memory follows the book) and requiring increasing ids per session (Nasdaq OUCH; one
      number a session). Either changes Alpha's published spec; the simulator and broker
      follow.

### 5. The simulator as a load generator

- [ ] Calmer market makers (the backlog item): fewer cancels per trade, so each transaction
      does more visible work and the same market costs less.
- [ ] If one Node process cannot produce the load: split it (a few symbols a process, each with
      its own FIX session), or lighten what it decodes (a trades-only or conflated feed channel,
      an additive spec change).
- [ ] `pnpm realism` at the new rate, so speed does not cost the market its shape.

### 6. Whatever the load test finds next

- [ ] Re-run after each stage; the next bottleneck may not be on this list (market-data's
      writes, the feed's fan-out, Postgres, the browser). Add a stage for it.

### 7. The live server, in steps

- [ ] Raise `SIM_ACTIVITY` (and its order cap) in steps, 4 to 10 to 25 and on, only to what the
      local test has shown the code can take.
- [ ] After each step, the ADR 0009 checks: CPU and credits (`CPUSurplusCreditsCharged`
      should stay 0), memory and swap, disk, the resend cap, cost, `pnpm realism`.
- [ ] If credits drain at the target: decide, with the numbers, between paying the surplus
      (about $0.04 per vCPU-hour above 20%) and a non-burstable instance (a `c7g.large` is
      about $52 a month). An ADR either way.
- [ ] Record the final number in ADR 0012 and the README.

## Already done that this builds on

- Bounded FIX resend window, 50,000 messages a session (ADR 0010, `v0.5.7`).
- Compact client order ids and mimalloc (ADR 0011, `v0.5.8`).
- Old images pruned on every deploy (ADR 0009, `v0.5.7`).
- Simulator at activity 4, cap 160 orders a second (`v0.5.9`).

## Not in this plan

Cancel/replace and mass quote messages, a binary journal, columnar trade storage (ClickHouse),
moving the exchange to its own server: each could raise the ceiling further, and each is its
own decision if the measurements call for it.
