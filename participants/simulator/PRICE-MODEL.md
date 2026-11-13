# Price model: plan

Making the simulated prices behave like a real stock's: busy and quiet stretches, big
candles without news, prices that respond to trading, and news that plays out over minutes
rather than in one step. Why, and the options weighed, are in
[ADR 0008](../../docs/adr/0008-realistic-prices-from-a-layered-model.md). Each stage below is
one PR, with its numbers saved next to the baseline.

## How the model is built

Fair value is a random walk in log price. Layers on top each add one thing a real price does
(`src/market/model/`):

| Layer | File | Since | What it does |
|---|---|---|---|
| Pull to reference | `pull.ts` | M4 | a weak pull back toward the reference price (half-life 3 days), so prices stay in the venue's fixed band |
| News | `news-layer.ts` | ADR 0006 | a headline moves fair value at once and heats the symbol up; heat speeds the walk and the agents |
| Trading impact | `impact.ts` | stage 2 | every trade on the public tape nudges fair value toward the side that took liquidity, by the square-root law; 40% stays, the rest fades over minutes. `SIM_IMPACT` scales it, `0` turns it off |

Each step, every layer may:

- **`volatility()`**: scale how fast the walk moves right now (multiplied together);
- **`drift(moment)`**: add a move that is not random (added together);
- **`advance(moment)`**: update its own state once the step is taken.

It may also take events from outside, as the news layer takes headlines. `layer.ts` has the
contract; `layers.ts` lists the layers every symbol gets, in order.

**To add a layer:** write a class in `src/market/model/` with the hooks it needs, its
tunable numbers as named constants with a comment each, and a test; add it to
`standardLayers()`; measure before and after (below). Draw random numbers only in
`advance()` or an event method, never in `volatility()` or `drift()`: the market makers ask
for volatility more than once a step.

## How it is measured

```
pnpm realism                                   # the live site, last 24 hours
pnpm realism --url http://127.0.0.1:8081 --hours 2
pnpm realism --hours 24 --out realism/baselines/<date>-<stage>.json
pnpm realism --hours 24 --compare realism/baselines/2026-11-13-before.json
```

It reads one-minute candles and headlines from a market-data service's public API, so it
measures the market as traded, order book and all. From the repo root, `pnpm simulator
realism ...`. The measures and what a real stock looks like are explained at the top of
`realism/stats.ts`. For a fair comparison use the same length of window at the same time of
day, ideally a whole day including New York market hours (14:30 to 21:00 UTC).

## Baseline (before any stage)

Live server, 2026-11-12 22:45 to 2026-11-13 05:15 UTC: the first six and a half hours of news,
all of it outside New York market hours, and a few headlines per symbol. Medians of the ten
symbols (`realism/baselines/2026-11-13-before.json`):

| Measure | Baseline | Real stock, roughly |
|---|---|---|
| Flat minutes | 23% | few |
| Excess kurtosis | 75 | 5 to 20 |
| Return autocorrelation, lag 1 / lag 2 | -0.13 / -0.02 | slightly negative / about 0 |
| Clustering, \|return\| autocorrelation at 5, 15, 30, 60 min | about 0 at all | positive, fading slowly |
| Volume against \|return\| | 0.29 | positive |
| Average move after news at 1, 5, 30 min | 213, 192, 159 bps | builds over minutes |
| Share of movement in the 5 min after headlines | 51% | a minority |

Retake it over a full day including market hours before stage 2 is merged, so stage 2 has a
fair comparison.

## Stages

### 1. Structure, measurement, baseline

- [x] Layers: `layer.ts` (the contract), `pull.ts`, `news-layer.ts`, `layers.ts`; FairValue
      built from them. Byte-identical prices to the model before it, checked over 6,000
      steps with news on three symbols.
- [x] A test that a new layer plugs in without touching the rest.
- [x] `realism/stats.ts` (pure, tested) and `realism/measure.ts` (`pnpm realism`).
- [x] Baseline saved; ADR 0008.

### 2. Trading moves the price

- [x] Every trade on the public tape (the simulator's and real users' alike) nudges fair
      value toward the aggressor's side: `λ · sign · √(qty / daily volume) · daily
      volatility`, λ = 0.5, capped at one day's volatility a trade. The feed already
      publishes each trade's aggressor side, so nothing private is needed.
- [x] Daily volume estimated from the tape (a 30-minute average, 3 minutes' warm-up), so it
      follows activity and the time of day; a thin market moves more per share.
- [x] 40% permanent; the rest fades with a 5-minute half-life (a decaying drift). Wall-clock
      time, like the trading it follows.
- [x] `SIM_IMPACT` scales it (0 is off), for tuning and as a switch.
- [ ] Target, to check on the live server over a full day after release: trading explains a
      large share of movement (30 to 60%); news share falls; momentum traders now produce
      trends and mean-reversion traders pull back.

### 3. Volatility with memory

- [ ] A volatility state per symbol, GARCH(1,1)-style per minute:
      `σ² = ω + α·r² + β·σ²`, α about 0.05 to 0.1, α + β about 0.97 to 0.99, ω set so the
      long-run level matches the profile's daily volatility. The time-of-day curve stays a
      multiplier.
- [ ] Shocks from a Student-t distribution (3 to 5 degrees of freedom) instead of a normal.
- [ ] Target: \|return\| autocorrelation positive and slow to fade; kurtosis from the walk
      itself, not only from news.

### 4. News over minutes

- [ ] 40 to 60% of a headline's move at once, the rest arriving over 2 to 8 minutes.
- [ ] In about 30% of stories, an overshoot of 10 to 30% that reverts over 15 to 30 minutes.
- [ ] Bursts last longer: heat half-life from 2 minutes to 15 to 45.
- [ ] Rebalance: news's share of daily variance well below today's roughly 90%; fewer or smaller
      moves overnight, when the rest of the market is slow.
- [ ] Optional: stories cluster (a Hawkes process: one story raises the chance of another).
- [ ] Target: the average path after news builds over minutes; news share a minority.

### 5. A soft band

- [ ] Replace the hard clamp with a pull that grows near the edges,
      `κ(x) = κ₀ · (1 + (x / b)⁴)`, and scale moves down by the room left.
- [ ] Final measurement over a full day against the baseline; update ADR 0008 with it.

## Sources

The research behind the stages: Cont 2001 (stylized facts); Ratliff-Crain et al. 2023
(retested intraday); Farmer, Patelli and Zovko 2005 (order flow shapes prices); Chiarella,
Iori and Perelló 2009, Lux and Marchesi 1999 (fundamentalist and chartist agents); Donier et
al. and Bouchaud on square-root impact; Bacry, Mastromatteo and Muzy on Hawkes processes;
Byrd et al. (ABIDES); Avellaneda and Stoikov (market making); Louhichi 2008 (intraday news
reaction).
