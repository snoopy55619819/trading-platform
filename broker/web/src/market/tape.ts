// Time and sales: the stored trades a symbol had before we subscribed, joined with the
// live ones since. Pure, so it is tested directly.

import type { TradeMessage } from "../api/marketData.ts";

/**
 * Both lists newest first; the result is too, at most `limit` long. A trade in both (stored
 * after it was also sent live) appears once: trade ids are unique per venue.
 */
export function mergeTrades(live: readonly TradeMessage[], stored: readonly TradeMessage[], limit: number): TradeMessage[] {
  const seen = new Set<string>();
  const merged: TradeMessage[] = [];
  for (const trade of [...live, ...stored]) {
    if (seen.has(trade.tradeId)) continue;
    seen.add(trade.tradeId);
    merged.push(trade);
  }
  // Stable: trades with the same timestamp keep the order they arrived in.
  return merged.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit);
}
