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
`fix_outbound` per outgoing message. Done in [ADR 0013](adr/0013-the-gateway-saves-fix-sessions-once-per-batch.md).

- [x] The core handles every event already waiting (up to 512), then saves once; replies are
      held until that save is done, so a client never has a message the exchange forgot.
- [x] One multi-row insert per save (`UNNEST`), with the resend window's delete in the same
      transaction (ADR 0010).
- [ ] ~~For sessions that reset on every logon, keep the window in memory only~~: not
      needed; a save per batch costs about a millisecond.
- [x] Load test before and after.

**After (2026-11-15, same laptop): every step of the standard run passes, up to about 860
transactions a second, and about 1,460 a second still answers within 50 ms.**

| Activity | Transactions/s | Answer p50 / p99, before | After |
|---|---|---|---|
| 4 | 27 to 31 | 8 / 30 ms | **6 / 8 ms** |
| 32 | 111 | 27 / 60 ms (stopped) | **7 / 9 ms** |
| 256 | 516 | 74 / 150 ms | **15 / 21 ms** |
| 512 | 858 | (not reached) | **23 / 31 ms** |
| 1024 | 1,465 (was 1,200, broken) | 2.2 s | **32 / 43 ms** |
| 4096 | 5,181 accepted | (not reached) | 50 / 68 ms; the gateway at 19% of a core |

(`load-test/results/2026-11-15-after-batching.json` and `-after-batching-ceiling.json`.)

What it found next: **the exchange is no longer the limit.** From about 1,500 a second the
simulator's market makers fall behind the takers (cancels drop towards zero, the book thins,
trades level off at about 1,450 a second), while the exchange still accepts everything sent.
The next limit is the simulator as a market (stage 5), and before going live, the journal
and finished-order memory at these rates (stages 3 and 4).

### 3. Journal retention and size

At 500 to 1,000 a second the journal is 7 to 13.5 GB a day; seven days do not fit 30 GB.

- [x] Keep at most one day uncompressed: `hosting/backup.sh` now gzips each finished day on
      the server, sends that to S3, and deletes the original as soon as S3 has it, keeping the
      compressed copy two days (it kept the originals a week). A journal gzips about 16 times
      smaller (measured: 307 MB to 19 MB for a day at activity 4). Tested by
      `hosting/backup.test.sh`, now in CI.
- [ ] ~~Batch the journal's writes, compress it as it is written, or a binary format~~: not
      needed for disk. With the change above the journal fits even at 1,000 a second (below).
      Batching its writes may still matter for CPU; the load test will say.

**The disk at the target** (30 GB; today about 6.3 GB is the system, images, swap and
databases). The fullest moment is just before the 21:00 roll, with the day's journal still
uncompressed:

| | Today (activity 4, about 25 a second) | 500 a second | 1,000 a second |
|---|---|---|---|
| The day's journal, uncompressed | 0.3 GB | 6.7 GB | 13.5 GB |
| Two compressed days | 0.04 GB | 0.8 GB | 1.7 GB |
| Peak, with the 6.3 GB base | 6.7 GB (22%) | 13.8 GB (46%) | 21.5 GB (72%) |
| **Trades kept by market-data, a day** (241 bytes each, measured) | 17 MB | 1 GB | 2.1 GB |

**What this found: market-data's trades are now the disk's limit.** It keeps every trade
forever (`ticks`; no ADR yet, only the backlog's "Tick retention without losing data"). At
500 a second that alone fills the disk's remaining 16 GB in about two weeks; at 1,000, in
about four days. The journal is solved; the trades need a decision before the live market
goes past about 100 a second for long:

- [x] Old trades leave the server's disk without being lost
      ([ADR 0014](adr/0014-market-data-archives-old-trades-by-day.md)): `ticks` is
      partitioned by day, Postgres keeps today and yesterday, and each finished day goes to
      S3 as a gzipped CSV, about 20 bytes a trade (12 times smaller). At 1,000 a second the
      trades then take at most about 4.2 GB, and the disk peaks at about 84%, over the 80%
      alarm: going that fast for long needs a bigger disk (stage 7).

### 4. Finished-order ids at scale

Done in [ADR 0015](adr/0015-client-order-ids-are-remembered-for-a-window.md), spec 1.3.0.

- [x] Measure the gateway's real peak: the gateway keeps one entry per transaction (cancel
      requests have their own `ClOrdID` too), and 992,000 took it to 168 MB, about 70 to 150
      bytes each. At 500 to 1,000 a second that is 3 to 12 GB a day: it does not fit.
- [x] The rule, chosen: a session's live orders' ids, plus its latest 1,000,000 finished,
      rejected and cancel ids, then forgotten oldest first. Bounded memory, the same answers as
      before for anything recent, and no client change (Cboe and CME check live orders only;
      Nasdaq OUCH requires increasing ids: both considered in the ADR).
- [x] Measured after: 190 MB at 1.34 million ids and still 190 MB at 1.72 million, at about
      5,000 transactions a second.

### 5. The simulator as a load generator

What the load test showed first: `SIM_ACTIVITY` only scaled the takers, so a fast market was
mostly trades. At about 500 transactions a second, 370 were trades, the market makers were
swept, and spreads reached 76 bps (`ACME`: 32 cents on $42). A real stock's messages are
mostly quotes placed, changed and pulled, with about one trade per 10 to 30.

- [x] **A second dial, `SIM_QUOTE_ACTIVITY`** (1 by default): how busy the book is apart
      from trading. Market makers re-price each resting quote about every 30 seconds at 1, more
      often above, with sizes varied 20% either way; patient traders come and go faster in
      step. Trades stay where `SIM_ACTIVITY` puts them. (Instead of the backlog's "calmer
      market makers": a busy book is the point now, and these messages are the realistic
      kind.)
- [x] One Node process makes the load: the simulator used at most 15% of a core at 5,000 a
      second in stage 4. No split needed.
- [ ] Reach 1,000 a second with this mix: the dial levels off near 520, because a quote can
      be re-priced at most once per 250 ms step (60 quotes, 4 times a second, an order and a
      cancel each). A shorter step, or more quote levels per symbol, raises it.
- [ ] `pnpm realism` at the new rate: on the live server, at stage 7. Quotes do not move fair
      value (only trades do, through impact), so the price model should keep its shape.

| `SIM_ACTIVITY`, `SIM_QUOTE_ACTIVITY` | Transactions/s | Trades/s | Messages a trade | Median spread |
|---|---|---|---|---|
| 256, 1 (before: takers only) | 514 | 366 | 1.4 | 76 bps on `ACME` |
| 16, 1 | 68 | 22 | 3 | 30 to 43 bps |
| 16, 200 | **429** | 22 | **19** | 29 bps |
| 16, 420 | **524** | 24 | **22** | 39 bps |

(`load-test/results/2026-11-16-quote-activity.json`; answers in 11 ms median, 15 ms 99th
percentile; nothing above 3% of a core.)

### 6. Whatever the load test finds next

- [ ] Re-run after each stage; the next bottleneck may not be on this list (market-data's
      writes, the feed's fan-out, Postgres, the browser). Add a stage for it.

### 7. The live server, in steps

- [ ] Raise the dials in steps, only to what the local test has shown the code can take.
      Since stage 5 that is mostly `SIM_QUOTE_ACTIVITY` (the book), with `SIM_ACTIVITY`
      (trades) kept near 4 so the price model's realism stays comparable:

      | Step | Release | `SIM_ACTIVITY`, `SIM_QUOTE_ACTIVITY`, order cap | Expected | Measured |
      |---|---|---|---|---|
      | 0 | `v0.5.11` | 4, 1, 160 | about 30 a second over the day, 50 in New York hours | (below) |
      | 1 | next | 4, 30, 400 | about 100 a second over the day, 130 in New York hours | |
      | 2 | | 4 to 8, 100 | about 300 | |
      | 3 | | 8 to 16, 200 | about 500 | |
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
