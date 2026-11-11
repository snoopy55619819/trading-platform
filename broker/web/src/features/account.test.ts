// Step 5d: the account summary, notifications, and settings.

import { describe, expect, test } from "vitest";

import type { Order, Positions } from "../api/backend.ts";
import { parseSettings } from "../settings.ts";
import { accountSummary } from "./account/summary.ts";
import type { Connections } from "./header/ConnectionStatus.tsx";
import { connectionNotices, orderNotices } from "./notifications/notices.ts";

const positions: Positions = {
  accountId: "a",
  cashCents: 1_000_000,
  reservedCents: 50_000,
  buyingPowerCents: 950_000,
  holdings: [
    { symbol: "ACME", qtySettled: 100, qtyUnsettled: 0, costBasisCents: 420_000, avgCostCents: 4200, realizedPnlCents: 1_000 },
    { symbol: "CRUX", qtySettled: 0, qtyUnsettled: 10, costBasisCents: 286_000, avgCostCents: 28600, realizedPnlCents: 0 },
    { symbol: "GONE", qtySettled: 0, qtyUnsettled: 0, costBasisCents: 0, avgCostCents: null, realizedPnlCents: 500 },
  ],
  closedRealizedPnlCents: 250,
};

describe("account summary", () => {
  test("total, unrealized and realized P&L at current prices", () => {
    const s = accountSummary(positions, new Map([["ACME", 4300], ["CRUX", 28000]]));
    expect(s.holdingsCents).toBe(430_000 + 280_000);
    expect(s.totalCents).toBe(1_000_000 + 710_000);
    expect(s.unrealizedCents).toBe(710_000 - 706_000);
    expect(s.realizedCents).toBe(1_000 + 500 + 250);
    expect(s.buyingPowerCents).toBe(950_000);
  });

  test("a holding without a price leaves the totals unknown, not wrong", () => {
    const s = accountSummary(positions, new Map([["ACME", 4300]]));
    expect(s.totalCents).toBeUndefined();
    expect(s.unrealizedCents).toBeUndefined();
    expect(s.cashCents).toBe(1_000_000);
  });

  test("no holdings: the total is the cash", () => {
    const s = accountSummary({ ...positions, holdings: [] }, new Map());
    expect(s.totalCents).toBe(1_000_000);
    expect(s.unrealizedCents).toBe(0);
  });
});

const order = (change: Partial<Order>): Order => ({
  orderId: "o1",
  clientOrderId: "c",
  venue: "ALPHA",
  symbol: "ACME",
  side: "BUY",
  orderType: "MARKET",
  timeInForce: "DAY",
  priceCents: null,
  qty: 100,
  status: "NEW",
  filledQty: 0,
  avgFillPriceCents: null,
  filledNotionalCents: 0,
  feeCents: 0,
  rejectReason: null,
  rejectText: null,
  exchangeOrderId: null,
  createdAt: "2026-11-11T10:00:00Z",
  updatedAt: "2026-11-11T10:00:00Z",
  ...change,
});

describe("order notices", () => {
  test("the first look is a baseline", () => {
    expect(orderNotices(undefined, [order({ status: "FILLED", filledQty: 100 })])).toEqual([]);
  });

  test("a partial fill, then the rest", () => {
    const working = [order({})];
    const part = [order({ status: "PARTIALLY_FILLED", filledQty: 40, avgFillPriceCents: 4205 })];
    const full = [order({ status: "FILLED", filledQty: 100, avgFillPriceCents: 4207 })];
    expect(orderNotices(working, part)).toEqual([{ tone: "good", title: "Bought 40 ACME", text: "40 of 100 filled at 42.05 average." }]);
    expect(orderNotices(part, full)).toEqual([{ tone: "good", title: "Bought 100 ACME", text: "Filled at 42.07 average." }]);
    expect(orderNotices(full, full)).toEqual([]);
  });

  test("an order filled before it was ever seen still says so", () => {
    expect(orderNotices([], [order({ side: "SELL", status: "FILLED", filledQty: 100, avgFillPriceCents: 4200 })])).toEqual([
      { tone: "good", title: "Sold 100 ACME", text: "Filled at 42.00 average." },
    ]);
  });

  test("rejected (new or after being sent), expired, cancelled", () => {
    expect(orderNotices([], [order({ status: "REJECTED", rejectText: "100 shares available to sell" })])).toEqual([
      { tone: "bad", title: "Rejected: Buy 100 ACME", text: "100 shares available to sell" },
    ]);
    expect(orderNotices([order({})], [order({ status: "EXPIRED" })])[0]?.title).toBe("Expired: Buy 100 ACME");
    expect(orderNotices([order({})], [order({ status: "CANCELED", filledQty: 0 })])).toEqual([
      { tone: "info", title: "Cancelled: Buy 100 ACME", text: undefined },
    ]);
    // A brand-new order that is merely working is not news.
    expect(orderNotices([], [order({})])).toEqual([]);
  });
});

describe("connection notices", () => {
  const ok: Connections = { backend: "ok", exchange: "ok", prices: "ok" };
  test("lost and regained, but not merely connecting, and not on the first look", () => {
    expect(connectionNotices(undefined, { ...ok, prices: "bad" })).toEqual([]);
    expect(connectionNotices(ok, { ...ok, prices: "bad" }).map((n) => n.title)).toEqual(["Lost connection to live prices"]);
    expect(connectionNotices({ ...ok, exchange: "bad" }, ok).map((n) => n.title)).toEqual(["Reconnected to the exchange"]);
    expect(connectionNotices(ok, { ...ok, backend: "waiting" })).toEqual([]);
    expect(connectionNotices({ ...ok, backend: "bad" }, { ...ok, backend: "waiting" })).toEqual([]);
  });
});

describe("settings", () => {
  test("a saved default quantity, checked", () => {
    expect(parseSettings('{"defaultQty":25}')).toEqual({ defaultQty: 25 });
    for (const bad of [null, "not json", '{"defaultQty":0}', '{"defaultQty":1.5}', '{"defaultQty":"10"}']) {
      expect(parseSettings(bad)).toEqual({ defaultQty: 1 });
    }
  });
});
