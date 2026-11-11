// Cost basis, by the average-cost method, from the fills the ledger booked.
//
//   a buy   adds its notional plus its fee to the position's cost (a rebate lowers it)
//   a sell  removes the same share of the cost as the share of the position sold, and
//           realises the difference between the proceeds (less the fee) and that cost
//
// Integer cents throughout. The share of cost a partial sell removes is rounded to the
// nearest cent; selling out removes exactly what is left, so a closed position always ends
// at zero cost with no stray cent. The average cost is derived for display and never stored
// or used for arithmetic.
//
// Computed from `fills`, not from journal lines: the journal records quantities and cash,
// but not which cash bought which shares. The same fills are what reconciliation checks the
// journal against.

import type { Db } from "../db.ts";

export interface Cost {
  symbol: string;
  /** Shares held, by the fills. Equals the ledger's settled plus unsettled. */
  qty: number;
  /** What the shares held cost, fees included. */
  costBasisCents: number;
  /** costBasisCents / qty, rounded to the nearest cent. Null when nothing is held. */
  avgCostCents: number | null;
  /** Profit or loss already taken by selling, after fees. */
  realizedPnlCents: number;
}

interface FillRow {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  notional_cents: number;
  fee_cents: number;
}

export async function costs(db: Db, accountId: string): Promise<Map<string, Cost>> {
  const { rows } = await db.query<FillRow>(
    `SELECT symbol, side, qty, notional_cents, fee_cents FROM broker.fills
     WHERE account_id = $1 ORDER BY fill_seq`,
    [accountId],
  );
  return averageCost(rows);
}

/** The arithmetic, separated from the query so it is tested directly. */
export function averageCost(fills: FillRow[]): Map<string, Cost> {
  const bySymbol = new Map<string, Cost>();
  for (const fill of fills) {
    let cost = bySymbol.get(fill.symbol);
    if (!cost) {
      cost = { symbol: fill.symbol, qty: 0, costBasisCents: 0, avgCostCents: null, realizedPnlCents: 0 };
      bySymbol.set(fill.symbol, cost);
    }
    if (fill.side === "BUY") {
      cost.qty += fill.qty;
      cost.costBasisCents += fill.notional_cents + fill.fee_cents;
    } else {
      // No short selling, so a sell is never larger than the position. Guard anyway: a sell
      // with nothing held realises its whole proceeds.
      const held = cost.qty;
      const removed =
        held <= 0 ? 0 : fill.qty >= held ? cost.costBasisCents : Math.round((cost.costBasisCents * fill.qty) / held);
      cost.qty -= fill.qty;
      cost.costBasisCents -= removed;
      cost.realizedPnlCents += fill.notional_cents - fill.fee_cents - removed;
    }
    cost.avgCostCents = cost.qty > 0 ? Math.round(cost.costBasisCents / cost.qty) : null;
  }
  return bySymbol;
}
