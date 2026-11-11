// Keeping a chart current between history fetches: each live trade updates the bar it
// falls in, or opens a new one. The same arithmetic market-data uses to build bars from
// ticks, so the live candle and the stored one agree once the service catches up.

import type { Bar, Interval, TradeMessage } from "../api/marketData.ts";
import { INTERVAL_SECONDS } from "../api/marketData.ts";

/** Where the business day starts: the venue rolls at 21:00 UTC, so daily bars do too. */
const DAY_ROLL_MS = 21 * 3_600_000;

/** The start of the bucket a moment falls in, as epoch milliseconds. */
export function bucketStart(ms: number, interval: Interval): number {
  const size = INTERVAL_SECONDS[interval] * 1000;
  const offset = interval === "1d" ? DAY_ROLL_MS : 0;
  return Math.floor((ms - offset) / size) * size + offset;
}

/**
 * The bars with `trade` folded in. Returns a new array (bars are never mutated). A trade
 * older than the last bar's bucket is ignored: history already covers it, and the next
 * history fetch will show it correctly.
 */
export function foldTrade(bars: Bar[], trade: TradeMessage, interval: Interval): Bar[] {
  const at = bucketStart(Date.parse(trade.ts), interval);
  const last = bars.at(-1);
  const lastAt = last ? Date.parse(last.t) : -Infinity;
  if (at < lastAt) return bars;
  if (last && at === lastAt) {
    const updated: Bar = {
      ...last,
      highCents: Math.max(last.highCents, trade.priceCents),
      lowCents: Math.min(last.lowCents, trade.priceCents),
      closeCents: trade.priceCents,
      volume: last.volume + trade.qty,
      trades: last.trades + 1,
    };
    return [...bars.slice(0, -1), updated];
  }
  const opened: Bar = {
    t: new Date(at).toISOString(),
    openCents: trade.priceCents,
    highCents: trade.priceCents,
    lowCents: trade.priceCents,
    closeCents: trade.priceCents,
    volume: trade.qty,
    trades: 1,
  };
  return [...bars, opened];
}
