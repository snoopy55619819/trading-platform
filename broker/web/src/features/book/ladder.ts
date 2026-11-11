// The order book as rows to draw: asks above (highest first), bids below (best first), the
// spread between them, and each level's running total for the depth bars. Pure.

import type { BookMessage } from "../../api/marketData.ts";

export interface LadderRow {
  priceCents: number;
  qty: number;
  /** Shares at this price and every better one on the same side. */
  total: number;
  orders: number;
  /** total / the deepest side's total, 0 to 1: the depth bar's width. */
  depth: number;
}

export interface Ladder {
  /** Highest price first, so the best ask sits just above the spread. */
  asks: LadderRow[];
  /** Best (highest) first. */
  bids: LadderRow[];
  spreadCents: number | undefined;
  midCents: number | undefined;
}

export function ladder(book: Pick<BookMessage, "bids" | "asks">, depth = 10): Ladder {
  const totals = (levels: BookMessage["bids"]) => {
    let running = 0;
    return levels.slice(0, depth).map((l) => ({ ...l, total: (running += l.qty), depth: 0 }));
  };
  const bids = totals(book.bids);
  const asks = totals(book.asks);
  const deepest = Math.max(bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0);
  for (const row of [...bids, ...asks]) row.depth = deepest > 0 ? row.total / deepest : 0;
  const bestBid = bids[0]?.priceCents;
  const bestAsk = asks[0]?.priceCents;
  const both = bestBid !== undefined && bestAsk !== undefined;
  return {
    asks: asks.reverse(),
    bids,
    spreadCents: both ? bestAsk - bestBid : undefined,
    // Half a cent rounds down: a mid is only a guide.
    midCents: both ? Math.floor((bestAsk + bestBid) / 2) : undefined,
  };
}
