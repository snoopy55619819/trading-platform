import assert from "node:assert/strict";
import { test } from "node:test";

import { FixMessage } from "../src/fix/codec.ts";
import { MsgType, Tag } from "../src/fix/tags.ts";
import { type Fill, Orders, RateLimit } from "../src/orders.ts";

function setup(perSec = 100) {
  const sent: FixMessage[] = [];
  const fills: Fill[] = [];
  const orders = new Orders(
    (m) => {
      sent.push(m);
      return true;
    },
    new RateLimit(perSec, 0),
    (f) => fills.push(f),
  );
  return { orders, sent, fills };
}

const report = (clOrdId: string, fields: Record<number, string>) => {
  const message = new FixMessage(MsgType.ExecutionReport).set(Tag.ClOrdID, clOrdId);
  for (const [tag, value] of Object.entries(fields)) message.set(Number(tag), value);
  return message;
};

test("a limit order goes out as FIX with the price in cents formatted exactly", () => {
  const { orders, sent } = setup();
  orders.place({ account: "MM-ACME", symbol: "ACME", side: "buy", qty: 100, priceCents: 4205 }, 0);
  const message = sent[0]!;
  assert.equal(message.get(Tag.Price), "42.05");
  assert.equal(message.get(Tag.OrdType), "2");
  assert.equal(message.get(Tag.Side), "1");
  assert.equal(message.get(Tag.TimeInForce), "1"); // GTC
  orders.place({ account: "NOISE", symbol: "ACME", side: "sell", qty: 5 }, 0);
  assert.equal(sent[1]!.get(Tag.OrdType), "1");
  assert.equal(sent[1]!.get(Tag.Price), undefined);
  assert.notEqual(sent[0]!.get(Tag.ClOrdID), sent[1]!.get(Tag.ClOrdID));
});

test("fills reach the owner with exact cents, and a filled order closes", () => {
  const { orders, fills } = setup();
  const order = orders.place({ account: "MM-ACME", symbol: "ACME", side: "sell", qty: 100, priceCents: 4210 }, 0)!;
  orders.receive(report(order.clOrdId, { [Tag.ExecType]: "0", [Tag.OrdStatus]: "0", [Tag.OrderID]: "ALPHA-1", [Tag.LeavesQty]: "100" }));
  assert.equal(order.state, "live");
  orders.receive(report(order.clOrdId, {
    [Tag.ExecType]: "F", [Tag.OrdStatus]: "2", [Tag.OrderID]: "ALPHA-1",
    [Tag.LastQty]: "100", [Tag.LastPx]: "42.10", [Tag.LeavesQty]: "0", [Tag.Commission]: "-0.84",
  }));
  assert.deepEqual(fills, [{ account: "MM-ACME", symbol: "ACME", side: "sell", qty: 100, priceCents: 4210, feeCents: -84 }]);
  assert.equal(order.state, "done");
  assert.equal(orders.open().length, 0);
});

test("a cancel is confirmed through the cancel's own ClOrdID", () => {
  const { orders, sent } = setup();
  const order = orders.place({ account: "MM-ACME", symbol: "ACME", side: "buy", qty: 100, priceCents: 4200 }, 0)!;
  orders.receive(report(order.clOrdId, { [Tag.ExecType]: "0", [Tag.OrdStatus]: "0", [Tag.OrderID]: "ALPHA-1", [Tag.LeavesQty]: "100" }));
  orders.cancel(order, 0);
  const cancelId = sent[1]!.get(Tag.ClOrdID)!;
  assert.equal(sent[1]!.get(Tag.OrigClOrdID), order.clOrdId);
  orders.receive(report(cancelId, { [Tag.ExecType]: "4", [Tag.OrdStatus]: "4", [Tag.OrderID]: "ALPHA-1", [Tag.LeavesQty]: "0" }));
  assert.equal(order.state, "done");
});

test("the rate limit throttles new orders but never a cancel", () => {
  const { orders } = setup(2);
  const placed = [1, 2, 3].map(() =>
    orders.place({ account: "MM-ACME", symbol: "ACME", side: "buy", qty: 1, priceCents: 4200 }, 0),
  );
  assert.equal(placed.filter(Boolean).length, 2);
  assert.equal(orders.stats.throttled, 1);
  assert.equal(orders.cancel(placed[0]!, 0), true);
  // A second later the bucket has refilled (less the cancel's overdraft).
  assert.ok(orders.place({ account: "MM-ACME", symbol: "ACME", side: "buy", qty: 1, priceCents: 4200 }, 1000));
});

test("orders a crashed run left behind are adopted and cancelled on logon", () => {
  const { orders, sent } = setup();
  orders.adopt([{ clOrdId: "old-1", account: "MM-ACME", symbol: "ACME", side: "buy" }]);
  assert.equal(orders.cancelEverything(0), 1);
  assert.equal(sent[0]!.type, MsgType.OrderCancelRequest);
  assert.equal(sent[0]!.get(Tag.OrigClOrdID), "old-1");
  // Already gone at the exchange: the reject closes it here too.
  const reject = new FixMessage(MsgType.OrderCancelReject)
    .set(Tag.ClOrdID, sent[0]!.get(Tag.ClOrdID)!)
    .set(Tag.OrigClOrdID, "old-1")
    .set(Tag.OrdStatus, "8");
  orders.receive(reject);
  assert.equal(orders.open().length, 0);
});
