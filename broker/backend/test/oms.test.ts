// The OMS against the real database, each test in a rolled-back transaction. Execution
// reports are built by hand, as the exchange would send them.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { type Db, createPool } from "../src/db.ts";
import { FixMessage } from "../src/fix/codec.ts";
import { MsgType, Tag } from "../src/fix/tags.ts";
import { ulid } from "../src/ids.ts";
import { cashBalance, creditCash, holdings, openAccount } from "../src/ledger/index.ts";
import { type OrderRow, applyReport, cancelOrder, placeOrder } from "../src/oms/orders.ts";
import type { OrderRequest } from "../src/oms/risk.ts";

const pool = createPool();
after(() => pool.end());

async function rolledBack(work: (db: Db) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function funded(db: Db, cents = 1_000_000): Promise<string> {
  const account = await openAccount(db, "test");
  await creditCash(db, account, cents, ulid());
  return account;
}

const limitBuy = (priceCents: number, qty: number, symbol = "ACME"): OrderRequest =>
  ({ symbol, side: "BUY", orderType: "LIMIT", timeInForce: "GTC", priceCents, qty });

async function order(db: Db, orderId: string): Promise<OrderRow> {
  const { rows } = await db.query<OrderRow>("SELECT * FROM broker.orders WHERE order_id = $1", [orderId]);
  return rows[0]!;
}

let execs = 0;
function report(o: OrderRow, execType: string, fields: [number, string][] = []): FixMessage {
  return new FixMessage(MsgType.ExecutionReport, [
    [Tag.ClOrdID, o.order_id], [Tag.OrderID, `ALPHA-${o.order_id.slice(-6)}`], [Tag.ExecID, `test-${Date.now()}-${++execs}`],
    [Tag.ExecType, execType], [Tag.OrdStatus, "0"], ...fields,
  ]);
}
const fill = (o: OrderRow, qty: number, px: string, fee: string) =>
  report(o, "F", [[Tag.LastQty, String(qty)], [Tag.LastPx, px], [Tag.Commission, fee]]);

async function accepted(db: Db, account: string, request: OrderRequest, id = ulid()): Promise<OrderRow> {
  const placement = await placeOrder(db, account, id, request, true);
  assert.equal(placement.kind, "accepted", JSON.stringify(placement));
  return (placement as { order: OrderRow }).order;
}

test("an accepted buy reserves its worst cost, and the next order sees less buying power", () =>
  rolledBack(async (db) => {
    const account = await funded(db, 500_000);
    const first = await accepted(db, account, limitBuy(4200, 100));
    assert.equal(first.reserved_cents, 420_000 + 126); // notional + 3 bps fee, rounded up
    const second = await placeOrder(db, account, ulid(), limitBuy(4200, 20), true);
    assert.equal(second.kind, "rejected");
    assert.equal((second as { order: OrderRow }).order.reject_reason, "INSUFFICIENT_BUYING_POWER");
  }));

test("rejections are recorded with their reason; a reused client id replays or refuses", () =>
  rolledBack(async (db) => {
    const account = await funded(db);
    const off = await placeOrder(db, account, "c1", limitBuy(28_652, 1, "CRUX"), true);
    assert.equal(off.kind, "rejected");
    const replay = await placeOrder(db, account, "c1", limitBuy(28_652, 1, "CRUX"), true);
    assert.equal(replay.kind, "replayed");
    const clash = await placeOrder(db, account, "c1", limitBuy(28_650, 1, "CRUX"), true);
    assert.deepEqual(clash.kind === "refused" && clash.reason, "DUPLICATE_CLIENT_ORDER_ID");
    const unknown = await placeOrder(db, account, "c2", limitBuy(100, 1, "NOPE"), true);
    assert.equal(unknown.kind === "refused" && unknown.reason, "UNKNOWN_SYMBOL");
  }));

test("acks and fills move the order, book the ledger, and release the reservation", () =>
  rolledBack(async (db) => {
    const account = await funded(db);
    const o = await accepted(db, account, limitBuy(4200, 100));
    await applyReport(db, report(o, "0"));
    assert.equal((await order(db, o.order_id)).status, "NEW");

    await applyReport(db, fill(o, 40, "42.00", "0.50"));
    let now = await order(db, o.order_id);
    assert.equal(now.status, "PARTIALLY_FILLED");
    assert.equal(now.filled_qty, 40);
    assert.equal(now.reserved_cents, 60 * 4200 + Math.ceil((60 * 4200 * 3) / 10_000));

    await applyReport(db, fill(o, 60, "41.95", "-0.50")); // price improvement, and a rebate
    now = await order(db, o.order_id);
    assert.equal(now.status, "FILLED");
    assert.equal(now.filled_notional_cents, 40 * 4200 + 60 * 4195);
    assert.equal(now.reserved_cents, 0);
    assert.equal(await cashBalance(db, account), 1_000_000 - 168_000 - 50 - 251_700 + 50);
    assert.deepEqual(await holdings(db, account), [{ symbol: "ACME", qtySettled: 0, qtyUnsettled: 100 }]);
  }));

test("an execution report delivered twice is applied once", () =>
  rolledBack(async (db) => {
    const account = await funded(db);
    const o = await accepted(db, account, limitBuy(4200, 10));
    const once = fill(o, 10, "42.00", "0.13");
    await applyReport(db, once);
    const resent = new FixMessage(MsgType.ExecutionReport, [...once.fields, [Tag.PossDupFlag, "Y"]]);
    await applyReport(db, resent);
    assert.equal((await order(db, o.order_id)).filled_qty, 10);
    assert.equal((await holdings(db, account))[0]?.qtyUnsettled, 10);
  }));

test("cancel: before it is sent it is cancelled here; after, it waits for the exchange", () =>
  rolledBack(async (db) => {
    const account = await funded(db);
    const unsentOrder = await accepted(db, account, limitBuy(4200, 1));
    const local = await cancelOrder(db, account, unsentOrder.order_id, true);
    assert.equal(local.kind, "cancelled");

    const o = await accepted(db, account, limitBuy(4200, 10));
    await db.query("UPDATE broker.orders SET sent_at = now() WHERE order_id = $1", [o.order_id]);
    const requested = await cancelOrder(db, account, o.order_id, true);
    assert.equal(requested.kind, "requested");
    const pending = await order(db, o.order_id);
    assert.equal(pending.status, "PENDING_CANCEL");

    // A fill races the cancel, then the cancel is confirmed through its own ClOrdID.
    await applyReport(db, fill(pending, 4, "42.00", "0.05"));
    assert.equal((await order(db, o.order_id)).status, "PENDING_CANCEL");
    await applyReport(db, new FixMessage(MsgType.ExecutionReport, [
      [Tag.ClOrdID, pending.cancel_cl_ord_id!], [Tag.OrderID, "ALPHA-9"], [Tag.ExecID, `x-${Date.now()}`],
      [Tag.ExecType, "4"], [Tag.OrdStatus, "4"],
    ]));
    const done = await order(db, o.order_id);
    assert.equal(done.status, "CANCELED");
    assert.equal(done.filled_qty, 4);
    assert.equal(done.reserved_cents, 0);
    const late = await cancelOrder(db, account, o.order_id, true);
    assert.equal(late.kind === "refused" && late.reason, "TOO_LATE_TO_CANCEL");
    const other = await cancelOrder(db, await funded(db), o.order_id, true);
    assert.equal(other.kind === "refused" && other.reason, "UNKNOWN_ORDER", "another account's order looks missing");
  }));

test("a refused cancel puts the order back to working", () =>
  rolledBack(async (db) => {
    const account = await funded(db);
    const o = await accepted(db, account, limitBuy(4200, 10));
    await db.query("UPDATE broker.orders SET sent_at = now() WHERE order_id = $1", [o.order_id]);
    await cancelOrder(db, account, o.order_id, true);
    const pending = await order(db, o.order_id);
    await applyReport(db, new FixMessage(MsgType.OrderCancelReject, [
      [Tag.ClOrdID, pending.cancel_cl_ord_id!], [Tag.OrigClOrdID, o.order_id], [Tag.OrdStatus, "0"], [Tag.Text, "no"],
    ]));
    assert.equal((await order(db, o.order_id)).status, "NEW");
  }));

test("the database refuses to reopen a finished order or overfill one", () =>
  rolledBack(async (db) => {
    const account = await funded(db);
    const o = await accepted(db, account, limitBuy(4200, 10));
    await db.query("SAVEPOINT s");
    await assert.rejects(db.query("UPDATE broker.orders SET filled_qty = 11 WHERE order_id = $1", [o.order_id]), /orders_never_overfilled/);
    await db.query("ROLLBACK TO SAVEPOINT s");
    await db.query("UPDATE broker.orders SET status = 'CANCELED', reserved_cents = 0 WHERE order_id = $1", [o.order_id]);
    await assert.rejects(db.query("UPDATE broker.orders SET status = 'NEW' WHERE order_id = $1", [o.order_id]), /which is final/);
    await db.query("ROLLBACK TO SAVEPOINT s");
    await assert.rejects(db.query("DELETE FROM broker.order_events WHERE order_id = $1", [o.order_id]), /append-only/);
  }));
