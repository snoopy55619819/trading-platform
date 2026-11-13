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
| Pull to reference | `pull.ts` | M4, soft band in stage 5 | a pull back toward the reference price: weak in the middle of the band (half-life 3 days), up to 9 times as strong at its edge, so prices stay in the venue's fixed band without lying flat against it |
| News | `news-layer.ts` | ADR 0006, reshaped in stage 4 | half a headline's move at once and the rest over about 4 minutes, with an overshoot given back in 30% of stories; heats the symbol up for about 15 minutes, which speeds the walk and the agents |
| Volatility memory | `memory.ts` | stage 3, normalised in stage 5 | GARCH(1,1) once a minute: a minute that moved more than the walk alone would (news, trading, a big candle) makes the next ones jumpier, fading over about an hour; divided by its own day-long average, so it averages 1 |
| Fat tails | `tails.ts` | stage 3 | each minute draws a variance multiplier (mean 1) that makes the minute's move Student-t with 5 degrees of freedom: big candles without news |
| Trading impact | `impact.ts` | stage 2 | every trade on the public tape nudges fair value toward the side that took liquidity, by the square-root law; 40% stays, the rest fades over minutes. `SIM_IMPACT` scales it, `0` turns it off |

Each step, every layer may:

- **`volatility()`**: scale how fast the walk moves right now (multiplied together);
- **`drift(moment)`**: add a move that is not random (added together);
- **`advance(moment, moved)`**: update its own state once the step is taken; `moved` is how
  far the price moved since the previous step, news and trades included, and
  `moment.rng` is the model's random numbers.

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

- [x] GARCH(1,1) per minute on a variance multiplier: `h = ω + α·e + β·h`, α = 0.08,
      β = 0.91 (α + β = 0.99), ω = 1 − α − β so h averages 1. `e` is the minute's actual
      squared move over what the walk alone would give, so news and trading count too;
      capped at 20, and h at 9. The time-of-day curve stays a multiplier.
- [x] Fat tails per minute, not per step (four steps a second would average fat-tailed
      steps back into a normal minute): a variance multiplier `(ν − 2) / χ²(ν)`, ν = 5,
      capped at 12, which makes each minute's move Student-t.
- [x] Measured on the model alone, 20 simulated days of ACME, same seed, before and after
      (`test/volatility.test.ts` checks these as properties):

      | | Before | After | Real stock |
      |---|---|---|---|
      | Excess kurtosis | 0.0 | 7.5 | 5 to 20 |
      | \|return\| autocorrelation at 1, 15, 60 min | 0.01, -0.01, -0.01 | 0.17, 0.15, 0.04 | positive, fading slowly |
      | Return autocorrelation, lag 1 | 0.006 | -0.001 | about 0 |
      | One-minute volatility | 6.6 bps | 5.5 bps | |

      The caps trim volatility by about a sixth; stage 4's rebalance of news against the
      walk is the place to set the overall level.
- [ ] On the live site after release: the same measures with `pnpm realism --compare`.

### 4. News over minutes

- [x] Half of a headline's move at once; the rest arrives with a 4-minute time constant.
- [x] In 30% of stories, an overshoot of 10 to 30% of the move, arriving with the rest and
      given back with a 20-minute half-life.
- [x] Bursts last longer: heat half-life from 2 minutes to 15. Its multipliers are gentler
      (walk 2.5x, takers 3.5x as often and 1.5x the size, quotes 60% the size at full heat),
      since bursts last seven times as long and the volatility memory carries the tail.
- [x] Rebalance: news moves are smaller (0.12 of a day's volatility times the jump size for
      MINOR, 0.35 for MAJOR, was 0.3 and 0.75), and the walk now delivers the profile's
      whole daily volatility: it was scaled by the time-of-day curve, which averages 0.42
      in its square, so a 3% symbol moved about 2% a day and news made up the rest.
- [x] The newswire follows the time of day (`participants/newswire/src/hours.ts`): busiest
      before the open and after the close, quiet overnight, the same number a day.
- [ ] Optional, not built: stories that cluster (a Hawkes process).
- [x] Measured on the whole model (walk, layers and the newswire's real schedule, with the
      real time-of-day curve), 20 simulated days of ACME, same seeds, `main` against stage 4:

      | | Before | After | Real stock |
      |---|---|---|---|
      | Excess kurtosis | 205 | 21 | 5 to 20 |
      | Average move after news at 1, 2, 5, 10, 30 min | 145, 147, 150, 149, 156 bps | 35, 42, 63, 73, 69 bps | builds over minutes |
      | Share of movement in the 5 min after news | 78% | 11% | a minority |
      | \|return\| autocorrelation at 1, 15, 60 min | 0.09, 0.05, 0.03 | 0.34, 0.29, 0.21 | positive, fading slowly |
      | One-minute volatility, over 24 hours | 14.6 bps | 19.3 bps | |
- [ ] On the live site after release: the same with `pnpm realism --compare`.

### 5. A soft band, and the overall level

- [x] The pull grows near the edges: `κ(x) = κ₀ · (1 + 8 · (x / b)⁴)`, from a 3-day
      half-life in the middle to about 8 hours at the edge. A move toward the nearer edge is
      scaled by the room left, `1 − (x / b)⁴`. The hard limit stays as a last resort.
- [x] Measured over two simulated years with the time-of-day curve: time pinned at the
      band's edge went from 0.11% of minutes (CRUX, up to 10 minutes at a time) to none,
      for HELX, CRUX and DYNE.
- [x] Found while measuring: every symbol moved about a fifth less than its profile. The
      volatility memory averaged 0.70, not 1: with its long memory (α + β = 0.99) a slight
      shortfall in the average surprise (the fat tails' cap makes it 0.987) compounds, and
      its own caps add to it (with no caps it still averaged 0.81). Fixed by dividing by a
      day-long running average of its own state, so it averages 1 whatever trims it. Daily
      volatility of a symbol with no news went from about 80% of its profile to about 93%
      (DYNE: 2.83% to 3.25%, profile 3.5%).
- [x] The whole model, 20 simulated days of ACME with the newswire's real schedule,
      stage 4 against stage 5:

      | | Stage 4 | Stage 5 | Real stock |
      |---|---|---|---|
      | One-minute volatility over 24 hours | 19.3 bps | 9.6 bps | |
      | Share of movement in the 5 min after news | 11% | 23% | a minority |
      | Excess kurtosis | 21 | 32 | 5 to 20 |
      | \|return\| autocorrelation at 1, 15, 60 min | 0.34, 0.29, 0.21 | 0.37, 0.29, 0.14 | positive, fading slowly |
      | Average move after news at 1, 5, 30 min | 35, 63, 69 bps | 36, 60, 71 bps | builds over minutes |

      Stage 4's numbers were inflated by the memory's bias the other way: news surprises fed
      it, so the walk ran at about twice its designed volatility and news looked small. Now
      the walk delivers the profile and news about as much again, as stage 4 intended.
      Kurtosis is above the usual range: with a quieter walk, news jumps stand out more.
      If the live numbers agree, lower it with one constant (fewer degrees of fat tails, or
      smaller MAJOR moves).
- [ ] Final measurement on the live site, a full day including market hours, against the
      baseline (`pnpm realism --compare realism/baselines/2026-11-13-before.json`); record
      it in ADR 0008.

## Sources

The research behind the stages: Cont 2001 (stylized facts); Ratliff-Crain et al. 2023
(retested intraday); Farmer, Patelli and Zovko 2005 (order flow shapes prices); Chiarella,
Iori and Perelló 2009, Lux and Marchesi 1999 (fundamentalist and chartist agents); Donier et
al. and Bouchaud on square-root impact; Bacry, Mastromatteo and Muzy on Hawkes processes;
Byrd et al. (ABIDES); Avellaneda and Stoikov (market making); Louhichi 2008 (intraday news
reaction).
