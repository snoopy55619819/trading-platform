// What every agent can see, and the firm's positions.

import type { FeedClient } from "../feed/client.ts";
import type { FairValue, Listing } from "../market/fair-value.ts";
import type { Rng } from "../market/rng.ts";
import type { Fill, Orders } from "../orders.ts";

export interface Agent {
  readonly name: string;
  /** Called every step. `dtSec` is wall-clock time since the last step. */
  step(now: number, dtSec: number): void;
}

export interface Context {
  listings: Map<string, Listing>;
  /** Hidden fair values. Only the market makers look at these; it stands in for their
   * information edge. Everyone else trades on public prices. */
  fair: Map<string, FairValue>;
  feed: FeedClient;
  orders: Orders;
  positions: Positions;
  rng: Rng;
  /** Diurnal activity times the configured multiplier. Recomputed every step. */
  activity: number;
}

/** A sensible order size for a symbol: about $10,000 of stock, in whole shares. */
export function lotFor(referenceCents: number): number {
  const shares = 1_000_000 / referenceCents;
  return Math.max(1, Math.round(shares / 10) * 10 || Math.round(shares));
}

export interface Position {
  qty: number;
  cashCents: number;
  feesCents: number;
  traded: number;
}

/** Positions per account and symbol, built from fills and nothing else. */
export class Positions {
  private readonly book = new Map<string, Position>();

  get(account: string, symbol: string): Position {
    const key = `${account}/${symbol}`;
    let position = this.book.get(key);
    if (!position) {
      position = { qty: 0, cashCents: 0, feesCents: 0, traded: 0 };
      this.book.set(key, position);
    }
    return position;
  }

  apply(fill: Fill): void {
    const position = this.get(fill.account, fill.symbol);
    const sign = fill.side === "buy" ? 1 : -1;
    position.qty += sign * fill.qty;
    position.cashCents -= sign * fill.qty * fill.priceCents + fill.feeCents;
    position.feesCents += fill.feeCents;
    position.traded += fill.qty;
  }

  /** Profit in cents, marking the position at `markCents`. */
  pnl(account: string, symbol: string, markCents: number): number {
    const position = this.get(account, symbol);
    return position.cashCents + position.qty * markCents;
  }
}
