// Orders and holdings as the activity panel shows them. Pure, so it is tested directly.

import type { Holding, Order, OrderEvent, OrderStatus } from "../../api/backend.ts";
import { WORKING_STATUSES } from "../../api/backend.ts";
import { changeBps, formatCents, formatDollars } from "../../money.ts";

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_NEW: "Sending",
  NEW: "Working",
  PARTIALLY_FILLED: "Part filled",
  PENDING_CANCEL: "Cancelling",
  FILLED: "Filled",
  CANCELED: "Cancelled",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};

export const isWorking = (order: Order) => WORKING_STATUSES.includes(order.status);

/** Working orders and finished ones, newest first, optionally for one symbol. */
export function splitOrders(orders: readonly Order[], symbol?: string): { open: Order[]; done: Order[] } {
  const mine = symbol ? orders.filter((o) => o.symbol === symbol) : orders;
  const newest = [...mine].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { open: newest.filter(isWorking), done: newest.filter((o) => !isWorking(o)) };
}

/** Shares of `symbol` held, settled or not. */
export function sharesOwned(holdings: readonly Holding[], symbol: string): number {
  return holdings.filter((h) => h.symbol === symbol).reduce((n, h) => n + h.qtySettled + h.qtyUnsettled, 0);
}

/** Shares of `symbol` that can still be sold: held, less what working sells already promise. */
export function availableToSell(holdings: readonly Holding[], orders: readonly Order[], symbol: string): number {
  const held = sharesOwned(holdings, symbol);
  const promised = orders
    .filter((o) => o.symbol === symbol && o.side === "SELL" && isWorking(o))
    .reduce((n, o) => n + o.qty - o.filledQty, 0);
  return Math.max(0, held - promised);
}

export interface PositionValue {
  qty: number;
  marketValueCents: number | undefined;
  /** Market value less what was paid for the shares still held (fees included). */
  pnlCents: number | undefined;
  pnlBps: number | undefined;
}

export function positionValue(holding: Holding, priceCents: number | undefined): PositionValue {
  const qty = holding.qtySettled + holding.qtyUnsettled;
  if (priceCents === undefined) return { qty, marketValueCents: undefined, pnlCents: undefined, pnlBps: undefined };
  const marketValueCents = qty * priceCents;
  const pnlCents = marketValueCents - holding.costBasisCents;
  return { qty, marketValueCents, pnlCents, pnlBps: changeBps(marketValueCents, holding.costBasisCents) };
}

/** An order's price column: its limit, or "Market". */
export const orderPrice = (o: Order) => (o.priceCents === null ? "Market" : formatCents(o.priceCents));

/** One line for an event in an order's history. */
export function eventText(event: OrderEvent): string {
  const d = event.detail as Record<string, unknown>;
  const cents = (key: string) => (typeof d[key] === "number" ? (d[key] as number) : undefined);
  switch (event.type) {
    case "PLACED": {
      const reserved = cents("reserved_cents");
      return reserved ? `Accepted by the broker; ${formatDollars(reserved)} held back` : "Accepted by the broker";
    }
    case "ACKNOWLEDGED":
      return "Working at the exchange";
    case "FILL": {
      const qty = cents("qty");
      const price = cents("price_cents");
      const fee = cents("fee_cents");
      const feeText = fee === undefined ? "" : fee < 0 ? `, rebate ${formatDollars(-fee)}` : `, fee ${formatDollars(fee)}`;
      return `${qty?.toLocaleString("en-US") ?? "?"} filled at ${price === undefined ? "?" : formatCents(price)}${feeText}`;
    }
    case "REJECTED":
      return `Rejected: ${String(d.text ?? d.reason ?? "no reason given")}`;
    case "CANCEL_REQUESTED":
      return "Cancel sent to the exchange";
    case "CANCEL_REJECTED":
      return `Cancel refused: ${String(d.text ?? "no reason given")}`;
    case "CANCELED":
      return d.reason ? `Cancelled: ${String(d.reason)}` : "Cancelled";
    case "EXPIRED":
      return "Expired at the end of its time in force";
    default:
      return event.type.toLowerCase().replaceAll("_", " ");
  }
}

/** "14:03:22" today, "Nov 10 14:03" before that. */
export function orderTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString(undefined, { hour12: false })
    : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}
