// Which trades in time and sales just arrived, so their rows can flash (tape.css).
//
// Only trades above the row that was on top last time are new. That leaves out everything
// that is not a trade arriving: the first load, a change of symbol (the old top is not in
// the new list), showing more rows, and the minute's refetch filling in older trades below.

import { useEffect, useRef } from "react";

/** The ids above `previousTop`, newest first; none if there was no top, or it is gone. */
export function arrivedAbove(trades: readonly { tradeId: string }[], previousTop: string | undefined): string[] {
  if (previousTop === undefined) return [];
  const at = trades.findIndex((t) => t.tradeId === previousTop);
  return at > 0 ? trades.slice(0, at).map((t) => t.tradeId) : [];
}

/** How long a row counts as new: its flash, plus a little. */
export const FRESH_MS = 1200;

/**
 * The ids of trades that arrived in the last FRESH_MS. A row keeps its class for that long,
 * so the next trade arriving does not cut its flash short; after it, a row shown again (more
 * rows chosen, say) does not flash again.
 */
export function useArrived(trades: readonly { tradeId: string }[]): Set<string> {
  const top = useRef<string | undefined>(undefined);
  const arrivedAt = useRef(new Map<string, number>());
  const now = Date.now();
  const recent = new Map<string, number>();
  for (const [id, at] of arrivedAt.current) if (now - at < FRESH_MS) recent.set(id, at);
  for (const id of arrivedAbove(trades, top.current)) if (!recent.has(id)) recent.set(id, now);
  const newest = trades[0]?.tradeId;
  useEffect(() => {
    top.current = newest;
    arrivedAt.current = recent;
  });
  return new Set(recent.keys());
}
