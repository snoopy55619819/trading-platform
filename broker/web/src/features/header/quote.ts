// The quote header's numbers, worked out from what the feed and the daily bars say.
// Pure, so it is tested without a browser.

import type { Bar } from "../../api/marketData.ts";
import { changeBps } from "../../money.ts";
import type { SymbolMarket } from "../../market/store.ts";

export interface Quote {
  /** The last trade; failing that, today's close; failing that, nothing. */
  lastCents: number | undefined;
  bidCents: number | undefined;
  askCents: number | undefined;
  /** Since the previous business day's close. Undefined without one. */
  changeCents: number | undefined;
  changeBps: number | undefined;
  /** Shares traded today (this business day). */
  volume: number;
  /** False when the book cannot be trusted (before its snapshot, after a gap, feed down). */
  live: boolean;
}

/**
 * `dailyBars` are the symbol's 1d bars, oldest first, the last one being today's when there
 * has been a trade today. Days roll at the venue's 21:00 UTC, the same as the bars.
 */
export function quoteFrom(market: SymbolMarket, dailyBars: Bar[] | undefined, todayStartMs: number): Quote {
  const bars = dailyBars ?? [];
  const last = bars.at(-1);
  const today = last && Date.parse(last.t) >= todayStartMs ? last : undefined;
  // The previous close is the last bar before today, whether or not today has traded yet.
  const previous = today ? bars.at(-2) : last;
  const lastCents = market.lastPriceCents ?? today?.closeCents ?? previous?.closeCents;
  const prevClose = previous?.closeCents;
  return {
    lastCents,
    bidCents: market.book?.bids[0]?.priceCents,
    askCents: market.book?.asks[0]?.priceCents,
    changeCents: lastCents !== undefined && prevClose !== undefined ? lastCents - prevClose : undefined,
    changeBps: lastCents !== undefined && prevClose !== undefined ? changeBps(lastCents, prevClose) : undefined,
    volume: today?.volume ?? 0,
    live: market.book?.live ?? false,
  };
}
