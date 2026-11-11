// How a new set of bars reaches the chart. Redrawing everything on every trade would reset
// the chart many times a second; instead the common case, a live trade changing the last
// bar or opening a new one, becomes an update of just those bars. Pure, so it is tested.

import type { Bar } from "../../api/marketData.ts";

export type ChartChange = { kind: "reset" } | { kind: "update"; bars: Bar[] } | { kind: "none" };

/**
 * `foldTrade` keeps every untouched bar the same object, so "everything before the last
 * bar is the same object as before" means only the tail moved. Anything else (a refetch,
 * another symbol or interval) is a reset.
 */
export function chartChange(previous: readonly Bar[] | undefined, next: readonly Bar[]): ChartChange {
  if (!previous || previous.length === 0) return { kind: "reset" };
  if (previous === next) return { kind: "none" };
  const grew = next.length - previous.length;
  if (grew !== 0 && grew !== 1) return { kind: "reset" };
  const settled = previous.length - 1; // bars before the old last one must be untouched
  for (let i = 0; i < settled; i++) if (previous[i] !== next[i]) return { kind: "reset" };
  // The old last bar (maybe changed), then the new one if a bar opened.
  return { kind: "update", bars: next.slice(settled) };
}
