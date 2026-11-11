// The broker backend's API, typed. These types are the web client's own view of the
// backend's JSON: the two are separate deployables and share no code, so a field renamed on
// one side is caught here, at the boundary, not deep inside a component.

import { config } from "../config.ts";
import { session } from "./session.ts";

export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "DAY" | "GTC" | "IOC" | "FOK";
export type OrderStatus =
  | "PENDING_NEW" | "NEW" | "PARTIALLY_FILLED" | "PENDING_CANCEL"
  | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";

export const WORKING_STATUSES: readonly OrderStatus[] = ["PENDING_NEW", "NEW", "PARTIALLY_FILLED", "PENDING_CANCEL"];

export interface Security {
  symbol: string;
  name: string;
  venue: string;
  tickSizeCents: number;
  lotSize: number;
  status: string;
  referencePriceCents: number;
  priceBandPct: number;
}

export interface Holding {
  symbol: string;
  qtySettled: number;
  qtyUnsettled: number;
  costBasisCents: number;
  avgCostCents: number | null;
  realizedPnlCents: number;
}

export interface Positions {
  accountId: string;
  cashCents: number;
  reservedCents: number;
  buyingPowerCents: number;
  holdings: Holding[];
  closedRealizedPnlCents: number;
}

export interface Order {
  orderId: string;
  clientOrderId: string;
  venue: string;
  symbol: string;
  side: Side;
  orderType: OrderType;
  timeInForce: TimeInForce;
  priceCents: number | null;
  qty: number;
  status: OrderStatus;
  filledQty: number;
  avgFillPriceCents: number | null;
  filledNotionalCents: number;
  feeCents: number;
  rejectReason: string | null;
  rejectText: string | null;
  exchangeOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderEvent {
  type: string;
  status: OrderStatus;
  execId: string | null;
  detail: Record<string, unknown>;
  at: string;
}

export interface PlaceOrder {
  clientOrderId: string;
  symbol: string;
  side: Side;
  orderType: OrderType;
  timeInForce: TimeInForce;
  priceCents?: number;
  qty: number;
}

/** A refusal from the backend, with its named reason when it gave one. */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  /** For a rejected order, the order as recorded, with its reason. */
  readonly order: Order | undefined;

  constructor(status: number, body: Record<string, unknown>) {
    const reason = (body.rejectReason ?? body.reason) as string | undefined;
    const text = (body.rejectText ?? body.text) as string | undefined;
    super(text ?? reason ?? `HTTP ${status}`);
    this.status = status;
    this.reason = reason;
    this.order = typeof body.orderId === "string" ? (body as unknown as Order) : undefined;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = session.token();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${config.backendUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 401 && token) session.end(); // the backend forgot us: sign out
  if (!response.ok) throw new ApiError(response.status, json);
  return json as T;
}

export const backend = {
  signUp: (email: string, password: string, name: string) =>
    request<{ userId: string; accountId: string }>("POST", "/users", { email, password, name }),
  logIn: (email: string, password: string) => request<{ token: string }>("POST", "/sessions", { email, password }),
  status: () => request<{ venue: string; connected: boolean }>("GET", "/status"),
  symbols: () => request<{ symbols: Security[] }>("GET", "/symbols").then((r) => r.symbols),
  positions: () => request<Positions>("GET", "/positions"),
  deposit: (amountCents: number, reference: string) =>
    request<{ cashCents: number }>("POST", "/deposits", { amountCents, reference }),
  orders: () => request<{ orders: Order[] }>("GET", "/orders").then((r) => r.orders),
  order: (orderId: string) => request<Order & { events: OrderEvent[] }>("GET", `/orders/${orderId}`),
  placeOrder: (order: PlaceOrder) => request<Order>("POST", "/orders", order),
  cancelOrder: (orderId: string) => request<Order>("DELETE", `/orders/${orderId}`),
  watchlist: () => request<{ symbols: string[] }>("GET", "/watchlist").then((r) => r.symbols),
  watch: (symbol: string) => request<{ symbols: string[] }>("PUT", `/watchlist/${symbol}`).then((r) => r.symbols),
  unwatch: (symbol: string) => request<{ symbols: string[] }>("DELETE", `/watchlist/${symbol}`).then((r) => r.symbols),
};
