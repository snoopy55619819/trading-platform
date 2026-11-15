// Patient limit traders: the depth behind the best prices (ADR 0009). In a real market most
// of the order book is not market makers re-quoting every second; it is people who want to
// buy a little cheaper or sell a little dearer and leave an order resting for a while. Their
// orders sit at all sorts of distances and sizes, so the book has many prices, uneven sizes
// and the odd large order far from the touch. This is the "zero-intelligence" order flow of
// the research behind ADR 0008: random prices and sizes, and random lifetimes.
//
// Cheap on purpose: about one order per symbol every 20 seconds, scaled by the time of day,
// each resting for about 20 minutes. Next to the market makers' constant re-quoting, a few
// percent more orders.

import type { Mirror } from "../feed/mirror.ts";
import type { Listing } from "../market/fair-value.ts";
import { withinBand } from "../market/fair-value.ts";
import type { Rng } from "../market/rng.ts";
import type { Order, Side } from "../orders.ts";
import { type Agent, type Context, lotFor } from "./context.ts";

/** New orders per symbol per second, at an activity of 1. */
export const RATE_PER_SYMBOL = 1 / 20;
/** At most this many resting per symbol, so the book stays readable. */
export const MAX_RESTING = 12;
/** How long an order rests, on average, before it is given up (an exponential lifetime). */
export const MEAN_LIFETIME_SEC = 20 * 60;
/** How far behind its own best price an order rests, on average, as a share of the price. */
export const MEAN_DISTANCE = 0.003;
/** How often an order is an outlier, resting this many times further out than usual. */
export const OUTLIER_CHANCE = 0.1;
export const OUTLIER_FACTOR = 4;
/** How often an order is a block, this many times the usual size. */
export const BLOCK_CHANCE = 0.05;
export const BLOCK_FACTOR = 5;
/** Given up early when the market has moved this far away from it. */
export const STALE_DISTANCE = 0.04;

export interface PatientOrder {
  side: Side;
  priceCents: number;
  qty: number;
}

/**
 * One patient order for a symbol, or undefined when it would not fit (no two-sided book, or
 * outside the band). Rests behind the best price on its own side, so it never trades on
 * arrival. Pure, so it is tested directly.
 */
export function patientOrder(
  book: { bestBid: number; bestAsk: number },
  listing: Listing,
  held: number,
  rng: Rng,
): PatientOrder | undefined {
  const lot = lotFor(listing.referenceCents);
  const tick = listing.tickCents;
  // Either side, a little more often the one that shrinks what it already holds.
  const lean = Math.max(-0.3, Math.min(0.3, -held / (lot * 30)));
  const side: Side = rng.next() < 0.5 + lean ? "buy" : "sell";
  const touch = side === "buy" ? book.bestBid : book.bestAsk;
  let distance = touch * MEAN_DISTANCE * -Math.log(1 - rng.next()); // exponential
  if (rng.next() < OUTLIER_CHANCE) distance *= OUTLIER_FACTOR;
  const ticks = Math.max(1, Math.round(distance / tick));
  const priceCents = side === "buy" ? touch - ticks * tick : touch + ticks * tick;
  if (priceCents <= 0 || !withinBand(priceCents, listing)) return undefined;
  let size = lot * Math.exp(Math.log(0.5) + 0.8 * rng.normal()); // about half a lot, varied
  if (rng.next() < BLOCK_CHANCE) size *= BLOCK_FACTOR;
  return { side, priceCents, qty: Math.max(1, Math.round(size)) };
}

interface Resting {
  order: Order;
  expiresAt: number;
}

export class PatientTrader implements Agent {
  readonly name = "PATIENT";
  private readonly context: Context;
  private readonly resting = new Map<string, Resting[]>();

  constructor(context: Context) {
    this.context = context;
  }

  step(now: number, dtSec: number): void {
    const { listings, feed, orders, positions, rng, activity } = this.context;
    for (const [symbol, listing] of listings) {
      const mirror = feed.mirrors.get(symbol);
      const mine = (this.resting.get(symbol) ?? []).filter((r) => r.order.state !== "done");
      this.resting.set(symbol, mine);
      this.giveUp(mine, mirror, now);
      if (mine.length >= MAX_RESTING || !rng.chance(RATE_PER_SYMBOL * activity, dtSec)) continue;
      const bestBid = mirror?.bestBid();
      const bestAsk = mirror?.bestAsk();
      if (bestBid === undefined || bestAsk === undefined) continue;
      const wanted = patientOrder({ bestBid, bestAsk }, listing, positions.get(this.name, symbol).qty, rng);
      if (!wanted) continue;
      const order = orders.place({ account: this.name, symbol, ...wanted }, now);
      if (order) mine.push({ order, expiresAt: now + MEAN_LIFETIME_SEC * 1000 * -Math.log(1 - rng.next()) });
    }
  }

  /** Cancels orders whose time is up, or that the market has left far behind. */
  private giveUp(mine: Resting[], mirror: Mirror | undefined, now: number): void {
    const mid = mirror?.mid();
    for (const { order, expiresAt } of mine) {
      if (order.state !== "live") continue;
      const far = mid !== undefined && order.priceCents !== undefined && Math.abs(order.priceCents - mid) > mid * STALE_DISTANCE;
      if (now >= expiresAt || far) this.context.orders.cancel(order, now);
    }
  }
}
