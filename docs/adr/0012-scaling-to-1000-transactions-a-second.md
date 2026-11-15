# ADR 0012: Scaling to 500 to 1,000 transactions a second, measured by a load test

**Status:** accepted, 2026-11-15. Being built in stages (`docs/SCALE-PLAN.md`). Stage 1, the
load test, is built: about 70 transactions a second locally, limited by the gateway saving
its FIX sessions after every message. Touches the exchange, the simulator and the server; each stage that changes a
published rule gets its own ADR.

## Context

The live market moves, but slowly: at `SIM_ACTIVITY=2` the exchange handled about 17
transactions a second on average and about 25 in New York market hours; at 4 (`v0.5.9`),
about 35 and 50. A **transaction** here is anything a client sends that the exchange must
process: a new order or a cancel. It is the number venues publish ("messages a second"), and
it is what makes a screen look alive: each one moves the order book, and about one in five or
six orders trades, moving time and sales and the chart.

The goal is two things at once:

1. **A market that looks real:** an order book that changes many times a second, a tape that
   scrolls, candles that visibly form.
2. **A number to stand behind:** "the platform handles X transactions a second, end to end",
   measured, not estimated.

The target is **500 to 1,000 transactions a second**, 20 to 50 times today. At those rates:

| | 500 a second | 1,000 a second |
|---|---|---|
| Trades | about 50 a second | about 100 a second |
| Per symbol (ten) | about 5 trades and 50 book changes a second | about 10 and 100 |
| Execution reports out | about 600 a second | about 1,200 a second |
| Journal (156 bytes a transaction) | about 6.7 GB a day | about 13.5 GB a day |
| Trades stored by market-data | about 4.3 million a day (1 GB) | about 8.6 million (2 GB) |
| Orders a day, and their finished ids in the gateway (ADR 0011, 24 bytes each) | about 24 million, about 570 MB | about 47 million, about 1.1 GB |

500 a second per ten symbols is roughly a busy mid-cap stock each; 1,000 is busier.

The server is a `t4g.small`: 2 vCPUs, 2 GB, 30 GB of disk, and 20% average CPU sustained on
credits before unlimited mode charges about $0.04 per vCPU-hour above that (ADR 0009).

## Where it breaks, as far as reading the code can tell

In the order they are expected to bite, before any measurement:

1. **One Postgres `INSERT` per outgoing FIX message.** The gateway saves each session after a
   batch, with a statement per message: 600 to 1,200 round trips a second.
2. **Finished-order ids in memory.** About 570 MB at 500 a second fits a 2 GB server only
   just; 1.1 GB at 1,000 does not.
3. **Journal size.** 7 to 13.5 GB a day, kept seven days locally, does not fit 30 GB.
4. **The simulator producing the load.** One single-threaded Node process sending every order
   and decoding the whole feed (about 2,500 messages a second at 1,000).
5. **CPU cost.** Today's 7% average is mostly fixed overhead, so it cannot be extrapolated;
   likely above the free 20% at these rates.

Not bottlenecks at this scale: the matching engine (690,000 commands a second with its
journal, benchmarked), market-data's batched trade inserts, and the browser (the book and
tape are conflated to screen speed).

## Options

1. **Raise `SIM_ACTIVITY` and see.** Cheap, but it finds limits on the live server, and gives
   no number to quote.
2. **Move to a bigger server first.** Buys headroom without learning where the limits are,
   and costs from about $52 a month.
3. **A load test, then fix the first bottleneck it finds, and repeat.** Each fix is measured
   before and after; the number rises in steps with a reason for each.
4. **Re-architect up front** (binary journal, a multi-process simulator, columnar storage,
   new FIX messages) before measuring anything. Weeks of work aimed at guesses.

## Decision

Option 3.

- **A repeatable load test comes first** (`docs/SCALE-PLAN.md`, stage 1): the whole stack
  locally, the simulator ramped up step by step, reporting transactions a second accepted by
  the exchange, end to end, and what saturated first (CPU of which process, errors, throttling,
  feed gaps, latency). The same test re-run after every change.
- **Then one bottleneck at a time,** in the order the test finds them, each a small PR with
  its before and after. The expected order is the list above; the test decides.
- **Changes to Alpha's published rules get their own ADR when they come,** most likely the
  duplicate-id rule (live orders only, like Cboe and CME, or increasing ids, like Nasdaq OUCH;
  ADR 0011 recorded both as the fallbacks).
- **The live server follows in steps** (activity 4 to 10 to 25 and so on), each checked the way
  ADR 0009 did (CPU and credits, memory, disk, cost, realism), and only after the local test
  shows the code can take it.
- **A bigger instance only if the measurement says so:** if CPU credits drain at the target,
  either accept the surplus charge or move to a non-burstable instance, decided then with
  numbers.

## Consequences

- **The headline number is measured and reproducible**: anyone can run the load test.
- **The order of work may differ from the list above**; that is the point of measuring.
- **Some stages change published behaviour** (the duplicate-id rule, maybe new FIX messages
  such as cancel/replace) and are decided in their own ADRs.
- **Storage and cost grow with the rate:** journals kept fewer days locally (S3 has every day),
  trades several GB a day, possibly a larger instance. Each is recorded when it happens.
- **The simulator becomes a load generator as well as a market;** its realism is re-checked
  with `pnpm realism` at each step up, so speed does not cost the market its shape.
