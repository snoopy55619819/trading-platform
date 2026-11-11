// The order ticket's arithmetic: what was typed, as an order; what it would cost; and what
// the server is likely to refuse. Pure, so it is tested without a browser.
//
// Two kinds of finding:
//   problems  the ticket cannot be sent as typed (no quantity, "4x.1"): Review is disabled
//   hints     the server will probably refuse it (tick, lot, band, buying power, shares
//             held). Shown, never enforced: the server decides, and its reason is shown
// The checks mirror the backend's risk checks (oms/risk.ts) but share no code with them.

import type { PlaceOrder, Security } from "../../api/backend.ts";
import { formatCents, formatDollars, parseDollars } from "../../money.ts";
import type { Draft } from "./draft.ts";

export interface TicketContext {
  security: Security | undefined;
  bestBidCents: number | undefined;
  bestAskCents: number | undefined;
  lastCents: number | undefined;
  /** Undefined until positions have loaded. */
  buyingPowerCents: number | undefined;
  /** Shares held, less those already on working sells. */
  availableToSell: number | undefined;
}

export interface TicketCheck {
  /** The order to send, when the ticket parses. */
  order: Omit<PlaceOrder, "clientOrderId"> | undefined;
  problems: string[];
  hints: string[];
  /** What it should come to: the limit, or the touch for a market order. Fees not included. */
  estimateCents: number | undefined;
  /** For a buy: the cash the broker holds back until it fills (before fees). */
  reserveCents: number | undefined;
  /** "Buy 100 ACME at market", for the button and the confirmation. */
  summary: string;
}

/** Whole shares: "100", "1,000". Undefined for anything else, including 0. */
export function parseQty(text: string): number | undefined {
  const cleaned = text.trim().replaceAll(",", "");
  if (!/^\d+$/.test(cleaned)) return undefined;
  const qty = Number(cleaned);
  return qty > 0 && Number.isSafeInteger(qty) ? qty : undefined;
}

/** The highest price the venue's band allows, on a tick: where a market buy is reserved. */
export function bandCeilingCents(security: Security): number {
  const ceiling = Math.floor((security.referencePriceCents * (100 + security.priceBandPct)) / 100);
  return ceiling - (ceiling % security.tickSizeCents);
}

export function checkTicket(symbol: string, draft: Draft, ctx: TicketContext): TicketCheck {
  const problems: string[] = [];
  const hints: string[] = [];
  const { security } = ctx;
  const buy = draft.side === "BUY";
  const limit = draft.orderType === "LIMIT";

  const qty = parseQty(draft.qtyText);
  if (qty === undefined) problems.push(draft.qtyText.trim() ? "Quantity: whole shares, more than 0." : "Enter a quantity.");
  const priceCents = limit ? parseDollars(draft.priceText) : undefined;
  if (limit && (priceCents === undefined || priceCents === 0)) {
    problems.push(draft.priceText.trim() ? "Price: dollars and cents, like 42.10." : "Enter a limit price.");
  }

  if (security) {
    if (security.status !== "ACTIVE") hints.push(`${symbol} is ${security.status.toLowerCase()}: orders will be refused.`);
    if (qty !== undefined && qty % security.lotSize !== 0) hints.push(`Quantity must be a multiple of ${security.lotSize}.`);
    if (priceCents) {
      if (priceCents % security.tickSizeCents !== 0) {
        hints.push(`Price must be a multiple of ${formatCents(security.tickSizeCents)}.`);
      }
      const distance = Math.abs(priceCents - security.referencePriceCents);
      if (distance * 100 > security.referencePriceCents * security.priceBandPct) {
        hints.push(
          `More than ${security.priceBandPct}% from today's reference price of ${formatCents(security.referencePriceCents)}: the exchange allows ${formatCents(security.referencePriceCents - Math.floor((security.referencePriceCents * security.priceBandPct) / 100))} to ${formatCents(bandCeilingCents(security))}.`,
        );
      }
    }
  }

  // Market orders are estimated at the touch they would trade against first.
  const touch = buy ? (ctx.bestAskCents ?? ctx.lastCents) : (ctx.bestBidCents ?? ctx.lastCents);
  const unit = limit ? priceCents || undefined : touch;
  const estimateCents = qty !== undefined && unit !== undefined ? qty * unit : undefined;
  const reserveUnit = !buy ? undefined : limit ? priceCents || undefined : security ? bandCeilingCents(security) : undefined;
  const reserveCents = qty !== undefined && reserveUnit !== undefined ? qty * reserveUnit : undefined;

  if (buy && reserveCents !== undefined && ctx.buyingPowerCents !== undefined && reserveCents > ctx.buyingPowerCents) {
    hints.push(`Needs ${formatDollars(reserveCents)} plus fees held back; buying power is ${formatDollars(ctx.buyingPowerCents)}.`);
  }
  if (!buy && qty !== undefined && ctx.availableToSell !== undefined && qty > ctx.availableToSell) {
    hints.push(ctx.availableToSell === 0 ? `No ${symbol} shares to sell.` : `Only ${ctx.availableToSell.toLocaleString("en-US")} shares available to sell.`);
  }

  const order =
    problems.length === 0 && qty !== undefined
      ? {
          symbol,
          side: draft.side,
          orderType: draft.orderType,
          timeInForce: draft.timeInForce,
          qty,
          ...(limit && priceCents !== undefined ? { priceCents } : {}),
        }
      : undefined;
  const verb = buy ? "Buy" : "Sell";
  const how = limit ? (priceCents ? `at ${formatCents(priceCents)} or better` : "at a limit") : "at market";
  const tif = draft.timeInForce === "DAY" ? "" : `, ${draft.timeInForce}`;
  return {
    order,
    problems,
    hints,
    estimateCents,
    reserveCents,
    summary: `${verb} ${qty?.toLocaleString("en-US") ?? "–"} ${symbol} ${how}${tif}`,
  };
}
