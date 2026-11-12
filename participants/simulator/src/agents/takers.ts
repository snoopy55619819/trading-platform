// The agents that take liquidity. None of them sees fair value: they trade on the public
// feed, like any outside firm would.
//
//   noise           random arrivals, random side, small market orders: the background
//                   flow that keeps prints coming and pays the market makers' spread
//   momentum        buys when the short average of prices is above the long one, sells
//                   when below: makes moves run further, so trends appear
//   mean reversion  sells when price is far above its recent average, buys when far
//                   below: pulls overextended moves back
//
// All three are rate-limited by arrival probability (scaled by the time of day), a
// cooldown per symbol, and a position limit, so none can run away.
//
// After a headline a symbol is "hot" (market/news.ts): all three trade it more often, with
// shorter cooldowns, in bigger sizes. Their position limits stay the same.

import type { Mirror } from "../feed/mirror.ts";
import { tradeRateMultiplier, tradeSizeMultiplier } from "../market/news.ts";
import type { Side } from "../orders.ts";
import { type Agent, type Context, lotFor } from "./context.ts";

/** Orders per second per symbol, at an activity of 1. */
const NOISE_RATE = 0.12;
const SIGNAL_CHECK_RATE = 0.2;
/** How long a signal trader watches a symbol before its first trade there. */
const WARM_UP_MS = 60_000;

/** A time-weighted moving average: `alpha` depends on how long it has been. */
class Ema {
  private readonly tauSec: number;
  value: number | undefined;

  constructor(tauSec: number) {
    this.tauSec = tauSec;
  }

  update(sample: number, dtSec: number): number {
    if (this.value === undefined) this.value = sample;
    else this.value += (1 - Math.exp(-dtSec / this.tauSec)) * (sample - this.value);
    return this.value;
  }
}

/** A marketable limit: crosses the spread by `ticks`, so it trades now but cannot sweep. */
function aggressivePrice(mirror: Mirror, side: Side, tickCents: number, ticks = 2): number | undefined {
  const touch = side === "buy" ? mirror.bestAsk() : mirror.bestBid();
  if (touch === undefined) return undefined;
  return side === "buy" ? touch + ticks * tickCents : Math.max(tickCents, touch - ticks * tickCents);
}

export class NoiseTrader implements Agent {
  readonly name = "NOISE";
  private readonly context: Context;
  private readonly rate: number;

  constructor(context: Context, activityScale: number) {
    this.context = context;
    this.rate = NOISE_RATE * activityScale;
  }

  step(now: number, dtSec: number): void {
    const { listings, fair, feed, orders, positions, rng, activity } = this.context;
    for (const [symbol, listing] of listings) {
      const heat = fair.get(symbol)?.heat ?? 0;
      if (!rng.chance(this.rate * activity * tradeRateMultiplier(heat), dtSec)) continue;
      if (!feed.mirrors.get(symbol)?.isLive()) continue;
      const lot = lotFor(listing.referenceCents);
      const held = positions.get(this.name, symbol).qty;
      // Unbiased, except that a large position is more likely to be reduced than grown.
      const lean = Math.max(-0.3, Math.min(0.3, -held / (lot * 40)));
      const side: Side = rng.next() < 0.5 + lean ? "buy" : "sell";
      const qty = Math.max(1, Math.round(lot * 0.3 * tradeSizeMultiplier(heat) * Math.exp(0.7 * rng.normal())));
      orders.place({ account: this.name, symbol, side, qty }, now);
    }
  }
}

interface Signal {
  fast: Ema;
  slow: Ema;
  variance: Ema;
  cooldownUntil: number;
}

/** Shared shape of the two signal traders: sample prices, decide, trade, cool down. */
abstract class SignalTrader implements Agent {
  abstract readonly name: string;
  protected readonly context: Context;
  private readonly signals = new Map<string, Signal>();
  private readonly fastSec: number;
  private readonly slowSec: number;
  private readonly cooldownSec: number;
  private readonly rate: number;

  constructor(context: Context, activityScale: number, fastSec: number, slowSec: number, cooldownSec: number) {
    this.context = context;
    this.fastSec = fastSec;
    this.slowSec = slowSec;
    this.cooldownSec = cooldownSec;
    this.rate = SIGNAL_CHECK_RATE * activityScale;
  }

  /** Which way to trade, given the fast and slow averages and the price's spread around
   * the slow one (a standard deviation, in cents). */
  protected abstract decide(fast: number, slow: number, sd: number): Side | undefined;

  step(now: number, dtSec: number): void {
    const { listings, fair, feed, orders, positions, rng, activity } = this.context;
    for (const [symbol, listing] of listings) {
      const heat = fair.get(symbol)?.heat ?? 0;
      const mirror = feed.mirrors.get(symbol);
      const price = mirror?.mid() ?? mirror?.lastTradeCents;
      if (!mirror?.isLive() || price === undefined) continue;
      let signal = this.signals.get(symbol);
      if (!signal) {
        signal = {
          fast: new Ema(this.fastSec),
          slow: new Ema(this.slowSec),
          variance: new Ema(this.slowSec),
          cooldownUntil: now + WARM_UP_MS, // let the averages settle first
        };
        this.signals.set(symbol, signal);
      }
      const fast = signal.fast.update(price, dtSec);
      const slow = signal.slow.update(price, dtSec);
      const variance = signal.variance.update((price - slow) ** 2, dtSec);

      const busy = tradeRateMultiplier(heat);
      if (now < signal.cooldownUntil || !rng.chance(this.rate * activity * busy, dtSec)) continue;
      const side = this.decide(fast, slow, Math.sqrt(variance));
      if (!side) continue;
      const lot = lotFor(listing.referenceCents);
      const held = positions.get(this.name, symbol).qty;
      const limit = lot * 12;
      if ((side === "buy" && held >= limit) || (side === "sell" && held <= -limit)) continue;
      const priceCents = aggressivePrice(mirror, side, listing.tickCents);
      if (priceCents === undefined) continue;
      const qty = Math.max(1, Math.round(lot * (0.4 + rng.next() * 0.6) * tradeSizeMultiplier(heat)));
      const order = orders.place({ account: this.name, symbol, side, qty, priceCents, ioc: true }, now);
      if (order) signal.cooldownUntil = now + (this.cooldownSec * 1000) / (Math.max(0.2, activity) * busy);
    }
  }
}

export class MomentumTrader extends SignalTrader {
  readonly name = "MOMENTUM";

  constructor(context: Context, activityScale: number) {
    super(context, activityScale, 20, 180, 8);
  }

  protected decide(fast: number, slow: number, sd: number): Side | undefined {
    if (sd === 0) return undefined;
    const trend = (fast - slow) / sd;
    if (trend > 0.8) return "buy";
    if (trend < -0.8) return "sell";
    return undefined;
  }
}

export class MeanReversionTrader extends SignalTrader {
  readonly name = "MEANREV";

  constructor(context: Context, activityScale: number) {
    super(context, activityScale, 5, 600, 12);
  }

  protected decide(fast: number, slow: number, sd: number): Side | undefined {
    if (sd === 0) return undefined;
    const stretch = (fast - slow) / sd;
    if (stretch > 1.5) return "sell";
    if (stretch < -1.5) return "buy";
    return undefined;
  }
}
