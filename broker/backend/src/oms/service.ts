// The OMS as the API sees it: place and cancel, with the FIX session behind them.
//
// Each operation commits first and sends second. The order (or cancel) is in the database
// before a byte leaves; the send then records `sent_at` in the same transaction that stores
// the FIX message and its sequence number (see fix/initiator.ts). If the process dies in
// between, the order is committed but unsent, and the next logon sends it. Nothing is lost
// and nothing is sent that was not first recorded.

import type pg from "pg";

import { type Db, transaction } from "../db.ts";
import type { FixMessage } from "../fix/codec.ts";
import type { Initiator } from "../fix/initiator.ts";
import { MsgType, Tag } from "../fix/tags.ts";
import {
  type CancelResult, type OrderRow, type Placement, applyReport, cancelOrder, cancelRequest,
  newOrderSingle, placeOrder, unsent,
} from "./orders.ts";
import type { OrderRequest } from "./risk.ts";

class AlreadySent extends Error {}

export class Oms {
  private readonly pool: pg.Pool;
  private fix: Initiator | undefined;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Connects the OMS to its FIX session (they need each other, so this comes after both exist). */
  attach(fix: Initiator): void {
    this.fix = fix;
  }

  venueUp(): boolean {
    return this.fix?.isActive() ?? false;
  }

  /** When the exchange last sent anything over FIX, heartbeats included. Shown in the web header. */
  venueLastHeardAt(): number | undefined {
    return this.fix?.lastHeardAt();
  }

  async place(accountId: string, clientOrderId: string, request: OrderRequest): Promise<Placement> {
    const placement = await transaction(this.pool, (db) =>
      placeOrder(db, accountId, clientOrderId, request, this.venueUp()),
    );
    if (placement.kind === "accepted") await this.sendNew(placement.order);
    return placement;
  }

  async cancel(accountId: string, orderId: string): Promise<CancelResult> {
    const result = await transaction(this.pool, (db) => cancelOrder(db, accountId, orderId, this.venueUp()));
    if (result.kind === "requested" && !result.order.cancel_sent_at) await this.sendCancel(result.order);
    return result;
  }

  /** FIX handler: an application message from the exchange, inside its receipt's transaction. */
  async onMessage(db: Db, message: FixMessage): Promise<void> {
    if (message.type === MsgType.ExecutionReport || message.type === MsgType.OrderCancelReject) {
      await applyReport(db, message);
    } else if (message.type === MsgType.Reject) {
      console.warn(`fix: the exchange rejected one of our messages: ${message.get(Tag.Text) ?? "(no text)"}`);
    }
  }

  /** FIX handler: logged on. Sends anything committed but never sent. */
  async onActive(): Promise<void> {
    const { orders, cancels } = await unsent(this.pool);
    if (orders.length + cancels.length > 0) {
      console.log(`oms: sending ${orders.length} order(s) and ${cancels.length} cancel(s) committed while offline`);
    }
    for (const order of orders) await this.sendNew(order);
    for (const order of cancels) await this.sendCancel(order);
  }

  // Marking an order sent succeeds once, and only while it is still waiting to go (an order
  // cancelled before it was sent never goes). If the logon sweep and the original placement
  // both reach here, the second finds it already marked and aborts before anything is written:
  // a second NewOrderSingle would be refused as a duplicate ClOrdID, and that refusal would
  // read as the live order being rejected.
  private async sendNew(order: OrderRow): Promise<void> {
    await this.trySend(newOrderSingle(order),
      "UPDATE broker.orders SET sent_at = now() WHERE order_id = $1 AND sent_at IS NULL AND status = 'PENDING_NEW'", order.order_id);
  }

  private async sendCancel(order: OrderRow): Promise<void> {
    await this.trySend(cancelRequest(order),
      "UPDATE broker.orders SET cancel_sent_at = now() WHERE order_id = $1 AND cancel_sent_at IS NULL AND status = 'PENDING_CANCEL'", order.order_id);
  }

  /** A send that fails (the session dropped after the commit) is left for the next logon. */
  private async trySend(message: FixMessage, markSent: string, orderId: string): Promise<void> {
    if (!this.fix) return;
    try {
      await this.fix.send(message, async (db) => {
        const marked = await db.query(markSent, [orderId]);
        if (marked.rowCount === 0) throw new AlreadySent();
      });
    } catch (error) {
      if (error instanceof AlreadySent) return;
      console.warn(`oms: order ${orderId} not sent now; the next logon sends it (${(error as Error).message})`);
    }
  }
}
