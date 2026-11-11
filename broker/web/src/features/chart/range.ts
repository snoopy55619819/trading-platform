// How much time the chart shows, and which candle interval can show it. Pure, so it is
// tested; the chart section only stores the choice and the chart view only applies a frame.
//
// The two settings depend on each other. market-data returns at most MAX_BARS bars, so a
// fine interval cannot reach far back (1000 one-minute bars is under 17 hours), and a
// coarse one makes a short range pointless (an hour of daily bars is not even one candle).

import { DEFAULT_BARS, INTERVALS, INTERVAL_SECONDS, type Interval, MAX_BARS } from "../../api/marketData.ts";

export const RANGES = ["1H", "6H", "1D", "5D", "1M", "1Y", "All"] as const;
export type Range = (typeof RANGES)[number];

/** Seconds of each range. "All" is whatever the interval's history reaches, so it has none. */
export const RANGE_SECONDS: Record<Exclude<Range, "All">, number> = {
  "1H": 3_600,
  "6H": 6 * 3_600,
  "1D": 86_400,
  "5D": 5 * 86_400,
  "1M": 30 * 86_400,
  "1Y": 365 * 86_400,
};

/** Fewer candles than this across a range is too coarse to read. */
export const MIN_RANGE_BARS = 5;

const rangeSeconds = (range: Range): number | undefined => (range === "All" ? undefined : RANGE_SECONDS[range]);

/** Candles of `interval` it takes to cover `range`; undefined for "All". */
export function barsToCover(range: Range, interval: Interval): number | undefined {
  const seconds = rangeSeconds(range);
  return seconds === undefined ? undefined : Math.ceil(seconds / INTERVAL_SECONDS[interval]);
}

/** Whether `interval` can show `range`: within the bar cap, and with enough candles to read. */
export function fits(range: Range, interval: Interval): boolean {
  const bars = barsToCover(range, interval);
  return bars === undefined || (bars >= MIN_RANGE_BARS && bars <= MAX_BARS);
}

/**
 * The interval after picking a range: the current one if it fits, else the finest that
 * does. Finest, because that is the most detail the cap allows for that span.
 */
export function intervalForRange(range: Range, current: Interval): Interval {
  if (fits(range, current)) return current;
  return INTERVALS.find((interval) => fits(range, interval)) ?? current;
}

/**
 * The range after picking an interval by hand: the current one if it fits, else the
 * nearest that does (nearest by ratio, so 1H is nearer 6H than 1D). "All" always fits, so
 * it is the last resort, never the nearest.
 */
export function rangeForInterval(interval: Interval, current: Range): Range {
  if (fits(current, interval)) return current;
  const from = rangeSeconds(current)!; // "All" always fits, so `current` has seconds here
  let best: Range = "All";
  let bestDistance = Infinity;
  for (const range of RANGES) {
    const seconds = rangeSeconds(range);
    if (seconds === undefined || !fits(range, interval)) continue;
    const distance = Math.abs(Math.log(seconds / from));
    if (distance < bestDistance) {
      best = range;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * How many bars to fetch for a range: twice what it covers, so there is history to pan
 * back into, at least the usual amount, and never more than the cap. "All" is the cap.
 */
export function barsToFetch(range: Range, interval: Interval): number {
  const bars = barsToCover(range, interval);
  if (bars === undefined) return MAX_BARS;
  return Math.min(MAX_BARS, Math.max(DEFAULT_BARS, bars * 2));
}

/** Space after the last candle, in candles, so the latest one is not against the axis. */
export const RIGHT_OFFSET = 4;
/** A frame never holds fewer candles than this: a quiet hour should not be two giant ones. */
export const MIN_FRAME_BARS = 10;

/**
 * The logical range (bar indexes) that shows the last `range` of `bars`, ending at the
 * latest bar. Indexes rather than times because the chart spaces candles evenly with no
 * gaps: when trading is sparse, a time window holds few candles, and this finds them.
 */
export function frame(
  bars: readonly { t: string }[],
  range: Range,
  interval: Interval,
): { from: number; to: number } | undefined {
  if (bars.length === 0) return undefined;
  const last = bars.length - 1;
  const to = last + RIGHT_OFFSET;
  const seconds = rangeSeconds(range);
  if (seconds === undefined) return { from: 0, to };
  // The window ends where the latest candle's bucket ends.
  const start = Date.parse(bars[last]!.t) + (INTERVAL_SECONDS[interval] - seconds) * 1000;
  let first = bars.findIndex((bar) => Date.parse(bar.t) >= start);
  if (first < 0) first = last;
  return { from: Math.max(0, Math.min(first, last + 1 - MIN_FRAME_BARS)), to };
}
