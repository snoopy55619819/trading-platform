// A sparkline's shape: prices to an SVG path. Pure, so it is tested without a browser.

import type { Bar } from "../../api/marketData.ts";

/** Today's closes, oldest first: what the watchlist's sparkline draws. */
export function todaysCloses(bars: readonly Bar[] | undefined, todayStartMs: number): number[] {
  return (bars ?? []).filter((b) => Date.parse(b.t) >= todayStartMs).map((b) => b.closeCents);
}

/**
 * An SVG path through `values`, spread evenly across `width` and scaled to fill `height`
 * (top is high). `baseline`, when given, is kept in view, so the line sits above or below
 * the previous close the way the change says it should. Undefined with fewer than two
 * points: nothing to draw.
 */
export function sparklinePath(values: readonly number[], width: number, height: number, baseline?: number): string | undefined {
  if (values.length < 2) return undefined;
  const all = baseline === undefined ? values : [...values, baseline];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1; // a flat line sits in the middle
  const y = (v: number) => (max === min ? height / 2 : height - ((v - min) / span) * height);
  const step = width / (values.length - 1);
  return values.map((v, i) => `${i === 0 ? "M" : "L"}${round(i * step)},${round(y(v))}`).join(" ");
}

/** Where the baseline falls on the same scale, for a dashed reference line. */
export function baselineY(values: readonly number[], height: number, baseline: number): number {
  const all = [...values, baseline];
  const min = Math.min(...all);
  const max = Math.max(...all);
  return max === min ? height / 2 : round(height - ((baseline - min) / (max - min)) * height);
}

const round = (n: number) => Math.round(n * 10) / 10;
