# ADR 0008: Realistic prices, from a layered model and measured against real markets

**Status:** accepted, 2026-11-13. Being built in stages (`participants/simulator/PRICE-MODEL.md`):
stage 1 (the layered structure, the measurement tool and a baseline) and stage 2 (trading
moves the price) are built. Changes how the
simulator's fair value moves (`participants/simulator/src/market/`), not who decides it: the
simulator is still the only firm with a fair value, and nothing about the exchange, the
broker or the protocols changes.

## Context

The chart does not look like a real stock's. Between headlines the price barely moves; on a
headline it steps to a new level in one candle; then it is flat again. Measured on the live
server over the first six and a half hours of news (`pnpm realism`, saved in
`participants/simulator/realism/baselines/2026-11-13-before.json`; medians of the ten symbols):

| | Today | A real stock, roughly |
|---|---|---|
| Excess kurtosis of one-minute returns | 75 | 5 to 20 |
| Clustering (autocorrelation of absolute returns, 5 to 60 minutes) | about 0 | positive, fading slowly |
| Move after a moving headline, 1 minute and 30 minutes in | 213 and 159 bps: all at once | builds over minutes |
| Share of all movement in the 5 minutes after headlines | 51% (in 4% of the time) | a minority |
| Minutes with no price change | 23% | few, in a busy name |

The window is overnight in New York and has only a few headlines per symbol, so the numbers
are rough; the direction is not in doubt.

The causes are in the model (`market/fair-value.ts`, `market/news.ts`):

1. **News is almost all of the movement.** The random walk spreads a symbol's daily
   volatility over 24 hours and is slowed further by the time-of-day curve (to 0.2 overnight),
   while a headline moves the price by 0.3 to 0.75 of a day's volatility times a jump size of
   1.5 to 2.5. Over a day, news supplies roughly 90% of the variance (about 10 moving
   stories a day against a walk that averages well under its configured volatility).
2. **News arrives at the same rate overnight,** while the walk is slowed to a crawl.
3. **A headline moves fair value in one step, then nothing.**
4. **Trading never moves the price.** Takers trade against market makers who quote around a
   fair value that only the model moves, so trades bounce between bid and ask.
5. **Volatility has no memory** apart from a two-minute burst after news.

Real price series share a set of "stylized facts" (Cont 2001, retested on intraday data in
2023): fat tails, volatility clustering, almost no autocorrelation in returns, volume moving
with volatility, more movement at the open and close. Research simulators reproduce them
either with a richer price process or by letting prices come out of order flow, and usually
both.

## Options

1. **Tune the existing numbers.** Smaller news moves, faster walk. Quick, but a faster walk
   with normal shocks is still smooth and memoryless: no clustering, no fat tails between
   headlines.
2. **Replace the price process with one standard model** (GARCH, Heston, regime switching).
   Fixes clustering, but trading still would not move the price, and news would still step.
3. **Agent-based only:** let order flow alone move the price (zero-intelligence and
   fundamentalist/chartist models). The most "real", but hard to tune and to keep inside the
   venue's fixed price band, and a big rewrite.
4. **Layers on the existing walk, each added and measured on its own.** Keep the random walk
   and the agents; add one behaviour at a time (impact from order flow, volatility with
   memory, news over minutes, a soft band), each a small class with its own tunable numbers,
   and measure the market before and after each one.

## Decision

Option 4.

- **The model is a list of layers** (`src/market/model/`). Fair value is a random walk in
  log price; each layer may scale the walk's volatility, add a non-random move each step,
  and update its own state afterwards, and may take events from outside (the news layer
  takes headlines). Adding a behaviour is writing one class and adding it to
  `standardLayers()`; removing it is taking it out. The first version holds exactly today's
  two behaviours, the pull toward the reference price and news, and gives byte-identical
  prices to the model it replaces.
- **Realism is measured, not judged by eye.** `pnpm realism` reads one-minute candles and
  headlines from any market-data service's public API (the live site by default), so it
  measures what the market actually did, order book included, and prints flatness, fat tails,
  return autocorrelation, clustering, volume against moves, the average path after news and
  news's share of all movement. Each stage saves its numbers next to the baseline.
- **Stages, one PR each,** in the order the research ranks them by visible effect:
  1. the layered structure, the measurement and a baseline (this ADR);
  2. trading moves the price: each taker fill nudges fair value by about the square root of
     its size, part kept and part fading over minutes;
  3. volatility with memory (GARCH-style) and fat-tailed shocks;
  4. news over minutes (part at once, the rest arriving, sometimes overshooting), longer
     bursts, stories that cluster, news rebalanced against everything else and slowed
     overnight;
  5. a soft pull that only gets strong near the band's edges, then a final measurement.

Option 1 does not fix the shape. Option 2 leaves trading without effect. Option 3 is the
most faithful and the most work, and its hardest part, keeping prices inside a fixed band,
is easier with an explicit fair value to steer; stage 2 takes its key idea, that order flow
moves the price.

## Consequences

- **Every model change is measured.** A layer that does not move the numbers toward a real
  stock's is not kept, however plausible it sounds.
- **The numbers need enough market to be meaningful:** several hours, ideally a whole day
  including New York market hours, and a few headlines per symbol. Overnight-only windows
  understate everything, which the baseline's own note says.
- **The layers share one random number generator.** A layer that draws numbers changes every
  later draw, so adding one changes the path for a given seed. Tests check properties
  (stays in the band, wanders, clusters), not exact paths.
- **The market makers and takers are unchanged by stage 1.** They read fair value, its
  volatility and its heat exactly as before.
- **Since stage 2, trades move fair value.** The impact layer reads every trade from the
  public feed, which already publishes the aggressor's side, so it needs no private data
  and counts real users' trades as well as the simulator's: a large order from the web app
  moves the price. The simulator still has no backdoor.
