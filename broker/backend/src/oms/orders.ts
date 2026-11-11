// Orders in the database: placing one (with its risk check), cancelling one, and applying
// what the exchange says happened to it. Every function runs in the caller's transaction;
// nothing here talks to the network (service.ts sends, after the commit).

import type { Db } from "../db.ts";
import { type OrdStatus, RejectReason } from "../domain/index.ts";
import { FixMessage, fixTime, formatCents, parseCents } from "../fix/codec.ts";
import { MsgType, Tag } from "../fix/tags.ts";
import { ulid } from "../ids.ts";
import { cashBalance, holdings, postFill } from "../ledger/index.ts";
import { type Limits, type OrderRequest, type Security, check, reservationCents, worstPriceCents } from "./risk.ts";
import { isTerminal, transition, workingStatus } from "./state.ts";
import { VENUE, businessDate } from "./venue.ts";

export interface OrderRow {
  order_id: string;
  client_order_id: string;
  account_id: string;
  venue: string;
  symbol: string;
  side: "BUY" | "SELL";
  order_type: "LIMIT" | "MARKET";
  time_in_force: "DAY" | "GTC" | "IOC" | "FOK";
  price_cents: number | null;
  qty: number;
  status: OrdStatus;
  filled_qty: number;
  filled_notional_cents: number;
  fee_cents: number;
  reserved_cents: number;
  reject_reason: string | null;
  reject_text: string | null;
  exchange_order_id: string | null;
  cancel_cl_ord_id: string | null;
  sent_at: Date | null;
  cancel_sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type Placement =
  | { kind: "accepted"; order: OrderRow }
  | { kind: "rejected"; order: OrderRow }
  /** Refused before an order existed to record (unknown account or symbol, or a reused id). */
  | { kind: "refused"; reason: RejectReason; text: string }
  /** The same client order id again, for the same order: the original, unchanged. */
  | { kind: "replayed"; order: OrderRow };

const WORKING = "('PENDING_NEW', 'NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL')";

async function event(db: Db, orderId: string, type: string, status: OrdStatus, detail: object, execId?: string) {
  await db.query(
    `INSERT INTO broker.order_events (order_id, event_type, status, exec_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, type, status, execId ?? null, JSON.stringify(detail)],
  );
}

export async function placeOrder(
  db: Db,
  accountId: string,
  clientOrderId: string,
  request: OrderRequest,
  venueUp: boolean,
): Promise<Placement> {
  // Lock the account first: every order for it waits here, so two orders can never both
  // spend the same buying power.
  const account = await db.query("SELECT 1 FROM broker.accounts WHERE account_id = $1 FOR UPDATE", [accountId]);
  if (account.rowCount === 0) return { kind: "refused", reason: RejectReason.UNKNOWN_ACCOUNT, text: "no such account" };

  const existing = await db.query<OrderRow>(
    "SELECT * FROM broker.orders WHERE account_id = $1 AND client_order_id = $2",
    [accountId, clientOrderId],
  );
  if (existing.rows[0]) {
    const order = existing.rows[0];
    const same =
      order.symbol === request.symbol &&
      order.side === request.side &&
      order.order_type === request.orderType &&
      order.qty === request.qty &&
      (order.price_cents ?? undefined) === request.priceCents;
    return same
      ? { kind: "replayed", order }
      : { kind: "refused", reason: RejectReason.DUPLICATE_CLIENT_ORDER_ID, text: "clientOrderId was already used for a different order" };
  }

  const { rows: securities } = await db.query<{
    ticker: string; status: string; tick_size_cents: number; lot_size: number;
    reference_price_cents: number; price_band_pct: number;
  }>("SELECT * FROM broker.securities WHERE ticker = $1", [request.symbol]);
  const row = securities[0];
  const security: Security | undefined = row && {
    ticker: row.ticker,
    status: row.status,
    tickSizeCents: row.tick_size_cents,
    lotSize: row.lot_size,
    referencePriceCents: row.reference_price_cents,
    priceBandPct: row.price_band_pct,
  };

  const limits = await limitsFor(db, accountId);
  const { rows: working } = await db.query<{ reserved: number; buys: number; sells: number; recent: number }>(
    `SELECT
       coalesce(sum(reserved_cents) FILTER (WHERE status IN ${WORKING}), 0)::bigint AS reserved,
       coalesce(sum(qty - filled_qty) FILTER (WHERE status IN ${WORKING} AND symbol = $2 AND side = 'BUY'), 0)::bigint AS buys,
       coalesce(sum(qty - filled_qty) FILTER (WHERE status IN ${WORKING} AND symbol = $2 AND side = 'SELL'), 0)::bigint AS sells,
       count(*) FILTER (WHERE created_at > now() - interval '1 minute')::bigint AS recent
     FROM broker.orders WHERE account_id = $1`,
    [accountId, request.symbol],
  );
  const held = (await holdings(db, accountId)).find((h) => h.symbol === request.symbol);
  const verdict = check(
    request,
    security,
    limits,
    {
      cashCents: await cashBalance(db, accountId),
      reservedCents: working[0]?.reserved ?? 0,
      heldQty: held ? held.qtySettled + held.qtyUnsettled : 0,
      workingBuyQty: working[0]?.buys ?? 0,
      workingSellQty: working[0]?.sells ?? 0,
      ordersLastMinute: working[0]?.recent ?? 0,
    },
    venueUp,
  );

  // An order for something we do not list has no security to be recorded against.
  if (!verdict.ok && verdict.reason === RejectReason.UNKNOWN_SYMBOL) {
    return { kind: "refused", reason: verdict.reason, text: verdict.text };
  }

  const status: OrdStatus = verdict.ok ? "PENDING_NEW" : "REJECTED";
  const { rows } = await db.query<OrderRow>(
    `INSERT INTO broker.orders (order_id, client_order_id, account_id, venue, symbol, side, order_type,
        time_in_force, price_cents, qty, status, reserved_cents, reject_reason, reject_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      ulid(), clientOrderId, accountId, VENUE, request.symbol, request.side, request.orderType,
      request.timeInForce, request.priceCents ?? null, request.qty, status,
      verdict.ok ? verdict.reserveCents : 0,
      verdict.ok ? null : verdict.reason,
      verdict.ok ? null : verdict.text,
    ],
  );
  const order = rows[0]!;
  await event(db, order.order_id, verdict.ok ? "PLACED" : "REJECTED", status,
    verdict.ok ? { reserved_cents: verdict.reserveCents } : { reason: verdict.reason, text: verdict.text });
  return verdict.ok ? { kind: "accepted", order } : { kind: "rejected", order };
}

async function limitsFor(db: Db, accountId: string): Promise<Limits> {
  await db.query("INSERT INTO broker.risk_limits (account_id) VALUES ($1) ON CONFLICT DO NOTHING", [accountId]);
  const { rows } = await db.query<{ max_order_value_cents: number; max_position_qty: number; max_orders_per_min: number }>(
    "SELECT * FROM broker.risk_limits WHERE account_id = $1",
    [accountId],
  );
  const row = rows[0]!;
  return {
    maxOrderValueCents: row.max_order_value_cents,
    maxPositionQty: row.max_position_qty,
    maxOrdersPerMin: row.max_orders_per_min,
  };
}

export type CancelResult =
  | { kind: "requested"; order: OrderRow }
  /** Never reached the exchange, so it was cancelled here. */
  | { kind: "cancelled"; order: OrderRow }
  | { kind: "refused"; reason: RejectReason; text: string; order?: OrderRow };

export async function cancelOrder(db: Db, accountId: string, orderId: string, venueUp: boolean): Promise<CancelResult> {
  const { rows } = await db.query<OrderRow>(
    "SELECT * FROM broker.orders WHERE order_id = $1 AND account_id = $2 FOR UPDATE",
    [orderId, accountId],
  );
  const order = rows[0];
  // Someone else's order gets the same answer as a missing one: nothing to probe.
  if (!order) return { kind: "refused", reason: RejectReason.UNKNOWN_ORDER, text: "no such order" };
  if (isTerminal(order.status)) {
    return { kind: "refused", reason: RejectReason.TOO_LATE_TO_CANCEL, text: `order is ${order.status}`, order };
  }
  if (order.status === "PENDING_CANCEL") return { kind: "requested", order };

  if (!order.sent_at) {
    const updated = await update(db, order, { status: transition(order.status, "CANCELED"), reserved_cents: 0 });
    await event(db, order.order_id, "CANCELED", "CANCELED", { reason: "cancelled before it was sent" });
    return { kind: "cancelled", order: updated };
  }
  if (!venueUp) {
    return { kind: "refused", reason: RejectReason.VENUE_UNAVAILABLE, text: "not connected to the exchange", order };
  }
  const updated = await update(db, order, {
    status: transition(order.status, "PENDING_CANCEL"),
    cancel_cl_ord_id: ulid(),
    cancel_sent_at: null,
  });
  await event(db, order.order_id, "CANCEL_REQUESTED", "PENDING_CANCEL", { cancel_cl_ord_id: updated.cancel_cl_ord_id });
  return { kind: "requested", order: updated };
}

/** Applies an ExecutionReport or OrderCancelReject. Safe to call twice with the same one. */
export async function applyReport(db: Db, message: FixMessage): Promise<void> {
  const clOrdId = message.get(Tag.ClOrdID) ?? "";
  const exchangeId = message.get(Tag.OrderID) ?? "";
  const { rows } = await db.query<OrderRow>(
    `SELECT * FROM broker.orders
     WHERE order_id = $1 OR cancel_cl_ord_id = $1 OR ($2 <> '' AND exchange_order_id = $2)
     LIMIT 1 FOR UPDATE`,
    [clOrdId, exchangeId],
  );
  const order = rows[0];
  if (!order) {
    console.warn(`oms: report for an order we do not know (ClOrdID ${clOrdId}, OrderID ${exchangeId})`);
    return;
  }

  if (message.type === MsgType.OrderCancelReject) {
    if (order.status !== "PENDING_CANCEL") return; // a duplicate, already handled
    const back = transition(order.status, workingStatus(order.filled_qty));
    await update(db, order, { status: back, cancel_cl_ord_id: null, cancel_sent_at: null });
    await event(db, order.order_id, "CANCEL_REJECTED", back, { text: message.get(Tag.Text) ?? "" });
    return;
  }

  const execId = message.get(Tag.ExecID) ?? "";
  const seen = await db.query("SELECT 1 FROM broker.order_events WHERE exec_id = $1", [execId]);
  if (seen.rowCount) return; // resent by the exchange: applied the first time

  const changes: Partial<OrderRow> = {};
  if (exchangeId && !order.exchange_order_id) changes.exchange_order_id = exchangeId;
  let status = order.status;
  let type: string;
  const detail: Record<string, unknown> = { exchange_status: message.get(Tag.OrdStatus) };

  switch (message.get(Tag.ExecType)) {
    case "0": // New: the exchange has it
      type = "ACKNOWLEDGED";
      if (status === "PENDING_NEW") status = transition(status, "NEW");
      break;
    case "F": {
      type = "FILL";
      const qty = message.getInt(Tag.LastQty) ?? 0;
      const priceCents = parseCents(message.get(Tag.LastPx) ?? "0");
      const feeCents = parseCents(message.get(Tag.Commission) ?? "0");
      changes.filled_qty = order.filled_qty + qty;
      changes.filled_notional_cents = order.filled_notional_cents + qty * priceCents;
      changes.fee_cents = order.fee_cents + feeCents;
      Object.assign(detail, { qty, price_cents: priceCents, fee_cents: feeCents });
      await postFill(db, {
        fillId: `${order.venue}:${execId}`,
        execId,
        tradeId: execId,
        orderId: order.order_id,
        accountId: order.account_id,
        venue: order.venue,
        symbol: order.symbol,
        side: order.side,
        qty,
        priceCents,
        notionalCents: qty * priceCents,
        feeCents,
        currency: "USD",
        transactTsNs: BigInt(Date.now()) * 1_000_000n,
        businessDate: businessDate(new Date()),
      });
      if (changes.filled_qty === order.qty) status = transition(status, "FILLED");
      else if (status !== "PENDING_CANCEL") status = transition(status, "PARTIALLY_FILLED");
      break;
    }
    case "4":
      type = "CANCELED";
      status = isTerminal(status) ? status : transition(status, "CANCELED");
      break;
    case "C":
      type = "EXPIRED";
      status = isTerminal(status) ? status : transition(status, "EXPIRED");
      break;
    case "8":
      type = "REJECTED";
      if (!isTerminal(status)) {
        status = transition(status, "REJECTED");
        changes.reject_reason = RejectReason.EXCHANGE_REJECTED;
        changes.reject_text = `${message.get(Tag.Text) ?? "rejected"} (OrdRejReason ${message.get(Tag.OrdRejReason) ?? "?"})`;
      }
      break;
    default:
      type = `EXEC_TYPE_${message.get(Tag.ExecType)}`;
  }

  changes.status = status;
  const filled = changes.filled_qty ?? order.filled_qty;
  // What is still held back: the rest of a working buy, at the same worst price as when it
  // was placed. Zero for sells and for anything finished.
  changes.reserved_cents =
    isTerminal(status) || order.side === "SELL"
      ? 0
      : reservationCents(order.qty - filled, await unitPriceCents(db, order));
  await update(db, order, changes);
  await event(db, order.order_id, type, status, detail, execId);
}

/** The per-share price a buy's reservation is based on: its limit, or the band ceiling. */
async function unitPriceCents(db: Db, order: OrderRow): Promise<number> {
  if (order.price_cents !== null) return order.price_cents;
  const { rows } = await db.query<{ tick_size_cents: number; reference_price_cents: number; price_band_pct: number; status: string; lot_size: number }>(
    "SELECT * FROM broker.securities WHERE ticker = $1",
    [order.symbol],
  );
  const row = rows[0]!;
  return worstPriceCents(
    { symbol: order.symbol, side: order.side, orderType: order.order_type, timeInForce: order.time_in_force, qty: order.qty },
    {
      ticker: order.symbol, status: row.status, tickSizeCents: row.tick_size_cents, lotSize: row.lot_size,
      referencePriceCents: row.reference_price_cents, priceBandPct: row.price_band_pct,
    },
  );
}

async function update(db: Db, order: OrderRow, changes: Partial<OrderRow>): Promise<OrderRow> {
  const entries = Object.entries(changes);
  const sets = entries.map(([column], i) => `${column} = $${i + 2}`);
  const { rows } = await db.query<OrderRow>(
    `UPDATE broker.orders SET ${sets.join(", ")}, updated_at = now() WHERE order_id = $1 RETURNING *`,
    [order.order_id, ...entries.map(([, value]) => value)],
  );
  return rows[0]!;
}

/** Orders committed but never handed to the FIX session (a crash in between), and cancels likewise. */
export async function unsent(db: Db): Promise<{ orders: OrderRow[]; cancels: OrderRow[] }> {
  const orders = await db.query<OrderRow>(
    "SELECT * FROM broker.orders WHERE status = 'PENDING_NEW' AND sent_at IS NULL ORDER BY created_at",
  );
  const cancels = await db.query<OrderRow>(
    "SELECT * FROM broker.orders WHERE status = 'PENDING_CANCEL' AND cancel_sent_at IS NULL ORDER BY updated_at",
  );
  return { orders: orders.rows, cancels: cancels.rows };
}

export function newOrderSingle(order: OrderRow): FixMessage {
  const message = new FixMessage(MsgType.NewOrderSingle)
    .set(Tag.ClOrdID, order.order_id)
    .set(Tag.Account, order.account_id)
    .set(Tag.Symbol, order.symbol)
    .set(Tag.Side, order.side === "BUY" ? "1" : "2")
    .set(Tag.TransactTime, fixTime(order.created_at))
    .set(Tag.OrderQty, order.qty)
    .set(Tag.OrdType, order.order_type === "LIMIT" ? "2" : "1")
    .set(Tag.TimeInForce, { DAY: "0", GTC: "1", IOC: "3", FOK: "4" }[order.time_in_force]);
  if (order.price_cents !== null) message.set(Tag.Price, formatCents(order.price_cents));
  return message;
}

export function cancelRequest(order: OrderRow): FixMessage {
  const message = new FixMessage(MsgType.OrderCancelRequest)
    .set(Tag.OrigClOrdID, order.order_id)
    .set(Tag.ClOrdID, order.cancel_cl_ord_id ?? "")
    .set(Tag.Account, order.account_id)
    .set(Tag.Symbol, order.symbol)
    .set(Tag.Side, order.side === "BUY" ? "1" : "2")
    .set(Tag.TransactTime, fixTime(new Date()));
  if (order.exchange_order_id) message.set(Tag.OrderID, order.exchange_order_id);
  return message;
}

