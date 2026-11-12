// The highest high and lowest low among the candles in view, for the chart's "H" and "L"
// marks. Pure, so it is tested; the chart view only turns the answer into markers.

import type { Bar } from "../../api/marketData.ts";

export interface Extreme {
  /** Position in the bars, which is also the chart's logical index. */
  index: number;
  cents: number;
}

/**
 * The high and low among the bars whose centres fall within the logical range `from` to
 * `to` (the chart's visible range, which may be fractional and run past either end). On a
 * tie the earlier bar wins. Undefined when no bar is in view.
 */
export function visibleExtremes(
  bars: readonly Bar[],
  from: number,
  to: number,
): { high: Extreme; low: Extreme } | undefined {
  const first = Math.max(0, Math.ceil(from));
  const last = Math.min(bars.length - 1, Math.floor(to));
  if (first > last) return undefined;
  let high: Extreme = { index: first, cents: bars[first]!.highCents };
  let low: Extreme = { index: first, cents: bars[first]!.lowCents };
  for (let i = first + 1; i <= last; i++) {
    const bar = bars[i]!;
    if (bar.highCents > high.cents) high = { index: i, cents: bar.highCents };
    if (bar.lowCents < low.cents) low = { index: i, cents: bar.lowCents };
  }
  return { high, low };
}
