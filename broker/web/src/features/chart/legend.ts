// What the chart's legend says about one candle: open, high, low, close, volume, and how far
// it moved from open to close. All from integer cents, so the text is exact; the chart's
// own series is in dollars, but only for drawing.

import type { Bar } from "../../api/marketData.ts";
import { changeBps, formatBps, formatCents } from "../../money.ts";

export interface Legend {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  /** "+0.12 (+0.29%)": the candle's close against its open. */
  change: string;
  direction: "up" | "down" | "flat";
}

export function legendFor(bar: Bar): Legend {
  const moved = bar.closeCents - bar.openCents;
  const bps = changeBps(bar.closeCents, bar.openCents);
  const signed = `${moved > 0 ? "+" : ""}${formatCents(moved)}`;
  return {
    open: formatCents(bar.openCents),
    high: formatCents(bar.highCents),
    low: formatCents(bar.lowCents),
    close: formatCents(bar.closeCents),
    volume: bar.volume.toLocaleString("en-US"),
    change: bps === undefined ? signed : `${signed} (${formatBps(bps)})`,
    direction: moved > 0 ? "up" : moved < 0 ? "down" : "flat",
  };
}
