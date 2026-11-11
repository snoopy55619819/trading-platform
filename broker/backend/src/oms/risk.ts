// Pre-trade risk: everything that must be true before an order may leave the building.
// Pure. The OMS gathers the facts inside the order's transaction (with the account locked,
// so two orders cannot both spend the same cash) and asks this for a verdict.
//
// Checks run in a fixed order and the first failure is the reason given. Every rejection
// names exactly one reason; a bare "rejected" would be a bug.

import { RejectReason } from "../domain/index.ts";
import { WORST_FEE_BPS } from "./venue.ts";

export interface OrderRequest {
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "MARKET";
  timeInForce: "DAY" | "GTC" | "IOC" | "FOK";
  priceCents?: number | undefined;
  qty: number;
}

export interface Security {
  ticker: string;
  status: string;
  tickSizeCents: number;
  lotSize: number;
  referencePriceCents: number;
  priceBandPct: number;
}

export interface Limits {
  maxOrderValueCents: number;
  maxPositionQty: number;
  maxOrdersPerMin: number;
}

/** The account's state, read inside the order's transaction. */
export interface Exposure {
  cashCents: number;
  /** Cash already held back for working buys. */
  reservedCents: number;
  /** Shares held, settled and unsettled. */
  heldQty: number;
  /** Unfilled shares on working orders in this symbol. */
  workingBuyQty: number;
  workingSellQty: number;
  ordersLastMinute: number;
}

export type Verdict = { ok: true; reserveCents: number } | { ok: false; reason: RejectReason; text: string };

/**
 * The most a share can cost. A limit price for a limit order. For a market order, the top of
 * the venue's price band: nothing can rest above it, so nothing can trade above it either.
 */
export function worstPriceCents(request: OrderRequest, security: Security): number {
  if (request.priceCents !== undefined) return request.priceCents;
  const ceiling = Math.floor((security.referencePriceCents * (100 + security.priceBandPct)) / 100);
  return ceiling - (ceiling % security.tickSizeCents);
}

/** Cash to hold back for `qty` shares of a buy: the worst price plus the worst fee. */
export function reservationCents(qty: number, priceCents: number): number {
  const notional = qty * priceCents;
  return notional + Math.ceil((notional * Math.max(0, WORST_FEE_BPS)) / 10_000);
}

export function check(
  request: OrderRequest,
  security: Security | undefined,
  limits: Limits,
  exposure: Exposure,
  venueUp: boolean,
): Verdict {
  const reject = (reason: RejectReason, text: string): Verdict => ({ ok: false, reason, text });

  if (!security) return reject(RejectReason.UNKNOWN_SYMBOL, `${request.symbol} is not a security we trade`);
  if (security.status !== "ACTIVE") {
    return reject(RejectReason.SYMBOL_HALTED, `${security.ticker} is ${security.status}`);
  }
  if (request.qty % security.lotSize !== 0) {
    return reject(RejectReason.INVALID_LOT_SIZE, `quantity must be a multiple of ${security.lotSize}`);
  }
  if (request.priceCents !== undefined) {
    if (request.priceCents % security.tickSizeCents !== 0) {
      return reject(RejectReason.INVALID_TICK_SIZE, `price must be a multiple of ${security.tickSizeCents} cents`);
    }
    const distance = Math.abs(request.priceCents - security.referencePriceCents);
    if (distance * 100 > security.referencePriceCents * security.priceBandPct) {
      return reject(
        RejectReason.PRICE_OUT_OF_BAND,
        `price is more than ${security.priceBandPct}% from the reference price of ${security.referencePriceCents} cents`,
      );
    }
  }
  if (exposure.ordersLastMinute >= limits.maxOrdersPerMin) {
    return reject(RejectReason.RATE_LIMIT_EXCEEDED, `at most ${limits.maxOrdersPerMin} orders a minute`);
  }

  const price = worstPriceCents(request, security);
  if (request.qty * price > limits.maxOrderValueCents) {
    return reject(
      RejectReason.ORDER_VALUE_LIMIT_EXCEEDED,
      `order is worth up to ${request.qty * price} cents; the limit is ${limits.maxOrderValueCents}`,
    );
  }

  let reserveCents = 0;
  if (request.side === "SELL") {
    // No short selling: only what is held and not already promised to another sell.
    const available = exposure.heldQty - exposure.workingSellQty;
    if (request.qty > available) {
      return reject(RejectReason.INSUFFICIENT_POSITION, `${available} shares available to sell`);
    }
  } else {
    const resulting = exposure.heldQty + exposure.workingBuyQty + request.qty;
    if (resulting > limits.maxPositionQty) {
      return reject(
        RejectReason.POSITION_LIMIT_EXCEEDED,
        `would hold up to ${resulting} shares; the limit is ${limits.maxPositionQty}`,
      );
    }
    reserveCents = reservationCents(request.qty, price);
    const buyingPower = exposure.cashCents - exposure.reservedCents;
    if (reserveCents > buyingPower) {
      return reject(
        RejectReason.INSUFFICIENT_BUYING_POWER,
        `needs up to ${reserveCents} cents; buying power is ${buyingPower}`,
      );
    }
  }

  // Last, so every other rule can be checked without an exchange running.
  if (!venueUp) return reject(RejectReason.VENUE_UNAVAILABLE, "not connected to the exchange");
  return { ok: true, reserveCents };
}
