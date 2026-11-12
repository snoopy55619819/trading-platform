// The market maker: the agent that makes the market exist. It rests buy and sell orders
// at several prices around its estimate of fair value, earns the spread when others trade
// against them, and has to manage the inventory that leaves it holding.
//
//   spread     wider when volatility is higher, never under one tick
//   skew       holding stock? shade both quotes down, so it sells more than it buys
//   limits     what it has resting on a side never adds up to more than the inventory
//              it may still take on; past the limit only one lot stays at the touch, and
//              past 1.5x the limit that side goes
//   pulling    on a jump in fair value, cancel everything and wait: quotes at the old price
//              are free money for whoever trades against them first
//   news       after a headline the symbol is "hot" (market/news.ts): fair value moves
//              faster, so the spread widens by itself, and it shows smaller sizes

import { type FairValue, type Listing, toTick, withinBand } from "../market/fair-value.ts";
import { quoteSizeMultiplier } from "../market/news.ts";
import type { Order, Side } from "../orders.ts";
import { type Agent, type Context, lotFor } from "./context.ts";

export const LEVELS = 3;
/** How far ahead the spread allows for: about a minute of fair value movement. */
const HORIZON_SEC = 60;
const PAUSE_MS = 3000;

export interface Quote {
  side: Side;
  level: number;
  priceCents: number;
  qty: number;
}

export interface QuoteInputs {
  fairCents: number;
  /** Volatility per second, as a fraction of price. */
  volPerSec: number;
  inventory: number;
  maxInventory: number;
  lot: number;
  listing: Listing;
}

/** Half the distance between the best bid and ask, in cents (not yet on a tick). */
export function halfSpread(inputs: QuoteInputs): number {
  const { fairCents, volPerSec, listing } = inputs;
  const moveOverHorizon = fairCents * volPerSec * Math.sqrt(HORIZON_SEC);
  const minimum = fairCents * 0.0002; // 2 bps: what the taker fee and rebate are worth
  return Math.max(listing.tickCents, 0.5 * listing.tickCents + moveOverHorizon + minimum);
}

/** How far past the limit it will still show one lot at the touch. */
const HARD_LIMIT = 1.5;

/** The quotes the market maker wants resting right now. Pure, so it is tested directly. */
export function desiredQuotes(inputs: QuoteInputs): Quote[] {
  const { fairCents, inventory, maxInventory, lot, listing } = inputs;
  const tick = listing.tickCents;
  const half = halfSpread(inputs);
  // Holding inventory moves the price it quotes around, toward getting rid of it. At the
  // limit the shift is one and a half spreads: its offer is below fair value, so it pays
  // to get out.
  const leaning = Math.max(-HARD_LIMIT, Math.min(HARD_LIMIT, inventory / maxInventory));
  const center = fairCents - leaning * half * 3;
  // Room left on each side. Resting quotes may all fill at once, so together they must fit.
  const room = { buy: maxInventory - inventory, sell: maxInventory + inventory };
  const quotes: Quote[] = [];
  for (const side of ["buy", "sell"] as const) {
    const hardStop = side === "buy" ? inventory >= HARD_LIMIT * maxInventory : inventory <= -HARD_LIMIT * maxInventory;
    if (hardStop) continue;
    let used = 0;
    for (let level = 0; level < LEVELS; level++) {
      const offset = half + level * Math.max(tick, half);
      const price =
        side === "buy"
          ? Math.floor((center - offset) / tick) * tick
          : Math.ceil((center + offset) / tick) * tick;
      // Past the limit one lot stays at the touch, so the book keeps two sides.
      const qty = level === 0 && room[side] < lot ? lot : lot * (level + 1);
      if (level > 0 && used + qty > room[side]) break;
      if (price <= 0 || !withinBand(price, listing)) continue;
      used += qty;
      quotes.push({ side, level, priceCents: price, qty });
    }
  }
  // A heavily skewed center could put the bid at or above the ask. Never cross ourselves.
  const bestBid = Math.max(...quotes.filter((q) => q.side === "buy").map((q) => q.priceCents));
  for (const quote of quotes) {
    if (quote.side === "sell" && quote.priceCents <= bestBid) quote.priceCents = bestBid + tick;
  }
  return quotes;
}

export class MarketMaker implements Agent {
  readonly name: string;
  private readonly symbol: string;
  private readonly context: Context;
  private readonly fair: FairValue;
  private readonly lot: number;
  private readonly maxInventory: number;
  private readonly slots = new Map<string, Order>();
  private pausedUntil = 0;
  private lastFair: number | undefined;
  pulls = 0;

  constructor(symbol: string, context: Context) {
    const fair = context.fair.get(symbol);
    if (!fair) throw new Error(`no fair value for ${symbol}`);
    this.symbol = symbol;
    this.name = `MM-${symbol}`;
    this.context = context;
    this.fair = fair;
    this.lot = lotFor(fair.listing.referenceCents);
    this.maxInventory = this.lot * 8;
  }

  step(now: number): void {
    const { orders, positions } = this.context;
    const fairCents = this.fair.value();
    const inputs: QuoteInputs = {
      fairCents,
      volPerSec: this.fair.volPerSec(this.context.activity),
      inventory: positions.get(this.name, this.symbol).qty,
      maxInventory: this.maxInventory,
      lot: Math.max(1, Math.round(this.lot * quoteSizeMultiplier(this.fair.heat))),
      listing: this.fair.listing,
    };

    const half = halfSpread(inputs);
    const moved = this.lastFair === undefined ? 0 : Math.abs(fairCents - this.lastFair);
    this.lastFair = fairCents;
    if (this.fair.jumped || moved > 3 * half) {
      this.pulls += 1;
      this.pausedUntil = now + PAUSE_MS;
      for (const order of this.slots.values()) orders.cancel(order, now);
    }
    if (now < this.pausedUntil) return;

    const tick = this.fair.listing.tickCents;
    const quotes = desiredQuotes(inputs);
    for (const quote of quotes) {
      const key = `${quote.side}${quote.level}`;
      const current = this.slots.get(key);
      if (current && current.state !== "done") {
        if (current.state !== "live") continue; // waiting on the exchange
        const drift = Math.abs((current.priceCents ?? 0) - quote.priceCents);
        // Deeper levels tolerate more drift, which keeps the order rate sane.
        const tolerance = Math.max(tick * (quote.level + 1), Math.round(half / 3));
        const depleted = current.leaves < current.qty / 4;
        if (drift < tolerance && !depleted && current.qty === quote.qty) continue;
        // Replace now, without waiting for the cancel to be confirmed: waiting leaves the
        // level empty, and when every level moves at once, the whole side.
        orders.cancel(current, now);
      }
      const order = orders.place(
        {
          account: this.name,
          symbol: this.symbol,
          side: quote.side,
          qty: quote.qty,
          priceCents: toTick(quote.priceCents, tick),
        },
        now,
      );
      if (order) this.slots.set(key, order);
      else this.slots.delete(key);
    }
    // A side that must not be quoted (at the inventory limit) is cancelled.
    const wanted = new Set(quotes.map((q) => `${q.side}${q.level}`));
    for (const [key, order] of this.slots) {
      if (!wanted.has(key) && order.state === "live") orders.cancel(order, now);
    }
  }
}
