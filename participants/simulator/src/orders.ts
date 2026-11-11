// The firm's view of its own orders: what it sent, what the exchange said back, and who
// each fill belongs to. Every agent goes through this, which is also where the global
// rate limit lives.
//
// One FIX session for the whole firm, one account per agent. Self-trade prevention works
// per account at Alpha, so agents can trade with each other, as separate desks at one firm
// would; one session is how a real firm connects, and it means a single sequence-number
// state and a single allowlisted CompID.

import { FixMessage, fixTime, formatCents, parseCents } from "./fix/codec.ts";
import { MsgType, Tag } from "./fix/tags.ts";

export type Side = "buy" | "sell";

export interface Fill {
  account: string;
  symbol: string;
  side: Side;
  qty: number;
  priceCents: number;
  /** Positive is paid, negative is a rebate. */
  feeCents: number;
}

type State = "pending" | "live" | "cancelling" | "done";

export interface Order {
  clOrdId: string;
  account: string;
  symbol: string;
  side: Side;
  /** undefined for a market order */
  priceCents: number | undefined;
  qty: number;
  leaves: number;
  state: State;
  orderId?: string;
}

export interface SavedOrder {
  clOrdId: string;
  account: string;
  symbol: string;
  side: Side;
}

export interface Placement {
  account: string;
  symbol: string;
  side: Side;
  qty: number;
  /** Omit for a market order. */
  priceCents?: number;
  /** Immediate-or-cancel: take what is there now, never rest. */
  ioc?: boolean;
}

/** Sends a FIX message, or returns false if the session is not up. */
export type Send = (message: FixMessage) => boolean;

/** A token bucket: `perSec` actions a second, with up to a second's worth saved up. */
export class RateLimit {
  private readonly perSec: number;
  private tokens: number;
  private last: number;

  constructor(perSec: number, now: number) {
    this.perSec = perSec;
    this.tokens = perSec;
    this.last = now;
  }

  take(now: number, force = false): boolean {
    this.tokens = Math.min(this.perSec, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < 1 && !force) return false;
    this.tokens -= 1;
    return true;
  }
}

export class Orders {
  private readonly send: Send;
  private readonly limit: RateLimit;
  private readonly onFill: (fill: Fill) => void;
  private readonly runId = Date.now().toString(36);
  private next = 0;
  private readonly byClOrdId = new Map<string, Order>();
  private readonly byOrderId = new Map<string, Order>();
  /** cancel request ClOrdID -> the order it cancels */
  private readonly cancels = new Map<string, Order>();
  stats = { sent: 0, cancels: 0, fills: 0, rejects: 0, throttled: 0 };

  constructor(send: Send, limit: RateLimit, onFill: (fill: Fill) => void) {
    this.send = send;
    this.limit = limit;
    this.onFill = onFill;
  }

  /** Places an order, or returns undefined if throttled or offline. */
  place(placement: Placement, now: number): Order | undefined {
    if (!this.limit.take(now)) {
      this.stats.throttled += 1;
      return undefined;
    }
    // Unique across restarts: the exchange remembers every ClOrdID a session has used.
    const clOrdId = `${this.runId}-${++this.next}`;
    const message = new FixMessage(MsgType.NewOrderSingle)
      .set(Tag.ClOrdID, clOrdId)
      .set(Tag.Account, placement.account)
      .set(Tag.Symbol, placement.symbol)
      .set(Tag.Side, placement.side === "buy" ? "1" : "2")
      .set(Tag.TransactTime, fixTime(new Date(now)))
      .set(Tag.OrderQty, placement.qty);
    if (placement.priceCents === undefined) {
      message.set(Tag.OrdType, "1");
    } else {
      message.set(Tag.OrdType, "2").set(Tag.Price, formatCents(placement.priceCents));
    }
    message.set(Tag.TimeInForce, placement.ioc || placement.priceCents === undefined ? "3" : "1");
    if (!this.send(message)) return undefined;

    const order: Order = {
      clOrdId,
      account: placement.account,
      symbol: placement.symbol,
      side: placement.side,
      priceCents: placement.priceCents,
      qty: placement.qty,
      leaves: placement.qty,
      state: "pending",
    };
    this.byClOrdId.set(clOrdId, order);
    this.stats.sent += 1;
    return order;
  }

  /**
   * Asks to cancel a resting order. Cancels skip the queue (they may overdraw the rate
   * limit): pulling a quote is never the thing to delay.
   */
  cancel(order: Order, now: number): boolean {
    if (order.state !== "live" && order.state !== "pending") return false;
    this.limit.take(now, true);
    const cancelId = `${this.runId}-${++this.next}`;
    const message = new FixMessage(MsgType.OrderCancelRequest)
      .set(Tag.OrigClOrdID, order.clOrdId)
      .set(Tag.ClOrdID, cancelId)
      .set(Tag.Account, order.account)
      .set(Tag.Symbol, order.symbol)
      .set(Tag.Side, order.side === "buy" ? "1" : "2")
      .set(Tag.TransactTime, fixTime(new Date(now)));
    if (!this.send(message)) return false;
    order.state = "cancelling";
    this.cancels.set(cancelId, order);
    this.stats.cancels += 1;
    return true;
  }

  /** What to save so a restarted simulator can cancel what this one left resting. */
  saved(): SavedOrder[] {
    return this.open().map(({ clOrdId, account, symbol, side }) => ({ clOrdId, account, symbol, side }));
  }

  /** Takes on orders a previous run left behind, so `cancelEverything` cancels them too. */
  adopt(orders: SavedOrder[]): void {
    for (const saved of orders) {
      const order: Order = { ...saved, priceCents: undefined, qty: 0, leaves: 0, state: "live" };
      this.byClOrdId.set(saved.clOrdId, order);
    }
  }

  /** Orders that are, or may still be, resting at the exchange. */
  open(): Order[] {
    return [...this.byClOrdId.values()].filter((o) => o.state !== "done");
  }

  /**
   * After a reconnect the session started again from 1, so reports sent while we were away
   * are gone. Cancel everything that might still rest; the ones that already traded or
   * left are refused, which closes them just the same.
   */
  cancelEverything(now: number): number {
    let count = 0;
    for (const order of this.open()) {
      order.state = "live"; // whatever we last knew, it is worth a cancel now
      if (this.cancel(order, now)) count += 1;
    }
    return count;
  }

  /** An ExecutionReport or OrderCancelReject from the exchange. */
  receive(message: FixMessage): void {
    if (message.type === MsgType.ExecutionReport) this.onReport(message);
    else if (message.type === MsgType.OrderCancelReject) this.onCancelReject(message);
    else if (message.type === MsgType.Reject) {
      console.warn(`fix: session Reject: ${message.get(Tag.Text) ?? "(no text)"}`);
    }
  }

  private onReport(report: FixMessage): void {
    const clOrdId = report.get(Tag.ClOrdID) ?? "";
    const orderId = report.get(Tag.OrderID) ?? "";
    // A cancel's report carries the cancel request's ClOrdID; OrderID ties it to the order.
    const order =
      this.byClOrdId.get(clOrdId) ?? this.cancels.get(clOrdId) ?? this.byOrderId.get(orderId);
    if (!order) return; // from before a restart: nothing of ours to update
    if (orderId && !order.orderId) {
      order.orderId = orderId;
      this.byOrderId.set(orderId, order);
    }

    switch (report.get(Tag.ExecType)) {
      case "0": // New
        if (order.state === "pending") order.state = "live";
        break;
      case "F": {
        const qty = report.getInt(Tag.LastQty) ?? 0;
        const price = report.get(Tag.LastPx);
        const fee = report.get(Tag.Commission);
        this.stats.fills += 1;
        this.onFill({
          account: order.account,
          symbol: order.symbol,
          side: order.side,
          qty,
          priceCents: price === undefined ? 0 : parseCents(price),
          feeCents: fee === undefined ? 0 : parseCents(fee),
        });
        break;
      }
      case "8": // Rejected
        this.stats.rejects += 1;
        if (this.stats.rejects <= 20) {
          console.warn(
            `orders: ${order.account} ${order.side} ${order.symbol} rejected: ${report.get(Tag.Text)}`,
          );
        }
        break;
    }
    order.leaves = report.getInt(Tag.LeavesQty) ?? order.leaves;
    const status = report.get(Tag.OrdStatus);
    if (status === "2" || status === "4" || status === "8" || order.leaves === 0) {
      this.close(order);
    }
  }

  private onCancelReject(reject: FixMessage): void {
    const order = this.cancels.get(reject.get(Tag.ClOrdID) ?? "");
    if (!order) return;
    this.cancels.delete(reject.get(Tag.ClOrdID) ?? "");
    const status = reject.get(Tag.OrdStatus);
    // Too late (it traded or was already cancelled) or unknown: either way it is gone.
    if (status === "0" || status === "1") order.state = "live";
    else this.close(order);
  }

  private close(order: Order): void {
    order.state = "done";
    this.byClOrdId.delete(order.clOrdId);
    if (order.orderId) this.byOrderId.delete(order.orderId);
    for (const [cancelId, target] of this.cancels) {
      if (target === order) this.cancels.delete(cancelId);
    }
  }
}
