// The account's numbers, from backend positions joined with market prices. Pure.

import type { Positions } from "../../api/backend.ts";

export interface AccountSummary {
  /** Cash plus what the holdings are worth. Undefined while any holding has no price. */
  totalCents: number | undefined;
  cashCents: number;
  buyingPowerCents: number;
  /** Cash held back for working buys. */
  reservedCents: number;
  holdingsCents: number | undefined;
  /** Gain or loss on shares still held: their value less what they cost (fees included). */
  unrealizedCents: number | undefined;
  /** Profit already taken by selling, after fees, including positions since closed. */
  realizedCents: number;
}

export function accountSummary(positions: Positions, prices: ReadonlyMap<string, number | undefined>): AccountSummary {
  let holdingsCents: number | undefined = 0;
  let costCents = 0;
  for (const h of positions.holdings) {
    const qty = h.qtySettled + h.qtyUnsettled;
    if (qty === 0) continue;
    const price = prices.get(h.symbol);
    holdingsCents = price === undefined || holdingsCents === undefined ? undefined : holdingsCents + qty * price;
    costCents += h.costBasisCents;
  }
  return {
    totalCents: holdingsCents === undefined ? undefined : positions.cashCents + holdingsCents,
    cashCents: positions.cashCents,
    buyingPowerCents: positions.buyingPowerCents,
    reservedCents: positions.reservedCents,
    holdingsCents,
    unrealizedCents: holdingsCents === undefined ? undefined : holdingsCents - costCents,
    realizedCents: positions.holdings.reduce((n, h) => n + h.realizedPnlCents, 0) + positions.closedRealizedPnlCents,
  };
}
