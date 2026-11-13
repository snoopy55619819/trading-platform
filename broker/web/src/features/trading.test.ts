// The ticket's checks and the activity panel's arithmetic.

import { describe, expect, test } from "vitest";

import type { Holding, Order, OrderEvent, Security } from "../api/backend.ts";
import { availableToSell, eventText, positionValue, sharesOwned, splitOrders } from "./activity/orders.ts";
import type { Draft } from "./ticket/draft.ts";
import { bandCeilingCents, checkTicket, ownedText, parseQty, type TicketContext } from "./ticket/ticket.ts";

const ACME: Security = {
  symbol: "ACME",
  name: "Acme",
  venue: "ALPHA",
  tickSizeCents: 1,
  lotSize: 1,
  status: "ACTIVE",
  referencePriceCents: 4210,
  priceBandPct: 20,
};
const CRUX: Security = { ...ACME, symbol: "CRUX", tickSizeCents: 5, lotSize: 10, referencePriceCents: 28650, priceBandPct: 15 };

const draft = (change: Partial<Draft> = {}): Draft => ({
  side: "BUY",
  orderType: "MARKET",
  qtyText: "100",
  priceText: "",
  timeInForce: "DAY",
  ...change,
});
const ctx = (change: Partial<TicketContext> = {}): TicketContext => ({
  security: ACME,
  bestBidCents: 4200,
  bestAskCents: 4205,
  lastCents: 4203,
  buyingPowerCents: 10_000_000,
  availableToSell: 50,
  ...change,
});

describe("ticket", () => {
  test("quantity: whole shares only", () => {
    expect(parseQty("100")).toBe(100);
    expect(parseQty(" 1,000 ")).toBe(1000);
    for (const bad of ["", "0", "-5", "1.5", "1e3", "abc"]) expect(parseQty(bad)).toBeUndefined();
  });

  test("market buy: estimated at the ask, held back at the band ceiling", () => {
    const c = checkTicket("ACME", draft(), ctx());
    expect(c.order).toEqual({ symbol: "ACME", side: "BUY", orderType: "MARKET", timeInForce: "DAY", qty: 100 });
    expect(c.estimateCents).toBe(420_500);
    expect(bandCeilingCents(ACME)).toBe(5052);
    expect(c.reserveCents).toBe(505_200);
    expect(c.summary).toBe("Buy 100 ACME at market");
    expect(c.problems).toEqual([]);
    expect(c.hints).toEqual([]);
  });

  test("the band ceiling lands on a tick", () => {
    // 28650 * 1.15 = 32947.5 -> 32947 -> down to a multiple of 5.
    expect(bandCeilingCents(CRUX)).toBe(32945);
  });

  test("market sell is estimated at the bid and holds no cash", () => {
    const c = checkTicket("ACME", draft({ side: "SELL", qtyText: "10" }), ctx());
    expect(c.estimateCents).toBe(42_000);
    expect(c.reserveCents).toBeUndefined();
  });

  test("limit order: price required, estimated and held at the limit, TIF in the summary", () => {
    expect(checkTicket("ACME", draft({ orderType: "LIMIT" }), ctx()).problems).toEqual(["Enter a limit price."]);
    const c = checkTicket("ACME", draft({ orderType: "LIMIT", priceText: "42.10", timeInForce: "GTC" }), ctx());
    expect(c.order?.priceCents).toBe(4210);
    expect(c.estimateCents).toBe(421_000);
    expect(c.reserveCents).toBe(421_000);
    expect(c.summary).toBe("Buy 100 ACME at 42.10 or better, GTC");
  });

  test("unparseable input is a problem and gives no order", () => {
    const c = checkTicket("ACME", draft({ qtyText: "ten" }), ctx());
    expect(c.order).toBeUndefined();
    expect(c.problems).toEqual(["Quantity: whole shares, more than 0."]);
    expect(checkTicket("ACME", draft({ orderType: "LIMIT", priceText: "42.105" }), ctx()).problems).toEqual([
      "Price: dollars and cents, like 42.10.",
    ]);
  });

  test("what the server would refuse is a hint, and the order can still be sent", () => {
    const c = checkTicket("CRUX", draft({ orderType: "LIMIT", qtyText: "15", priceText: "400.02" }), ctx({ security: CRUX, buyingPowerCents: 100 }));
    expect(c.order).toBeDefined();
    expect(c.hints).toHaveLength(4);
    expect(c.hints[0]).toBe("Quantity must be a multiple of 10.");
    expect(c.hints[1]).toBe("Price must be a multiple of 0.05.");
    expect(c.hints[2]).toMatch(/^More than 15% from today's reference price of 286.50/);
    expect(c.hints[3]).toMatch(/^Needs \$6,000.30 plus fees held back; buying power is \$1.00/);
  });

  test("selling more than is available", () => {
    expect(checkTicket("ACME", draft({ side: "SELL", qtyText: "60" }), ctx()).hints).toEqual(["Only 50 shares available to sell."]);
    expect(checkTicket("ACME", draft({ side: "SELL" }), ctx({ availableToSell: 0 })).hints).toEqual(["No ACME shares to sell."]);
  });

  test("shares owned line", () => {
    expect(ownedText(0, 0)).toBe("None");
    expect(ownedText(25, 25)).toBe("25");
    expect(ownedText(1500, 1200)).toBe("1,500 (1,200 available)");
    expect(ownedText(25, 0)).toBe("25 (0 available)");
  });
});

const order = (change: Partial<Order>): Order => ({
  orderId: "o",
  clientOrderId: "c",
  venue: "ALPHA",
  symbol: "ACME",
  side: "BUY",
  orderType: "LIMIT",
  timeInForce: "DAY",
  priceCents: 4200,
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
const holding = (change: Partial<Holding>): Holding => ({
  symbol: "ACME",
  qtySettled: 80,
  qtyUnsettled: 20,
  costBasisCents: 400_000,
  avgCostCents: 4000,
  realizedPnlCents: 0,
  ...change,
});

describe("activity", () => {
  test("orders split into working and finished, newest first, optionally one symbol", () => {
    const orders = [
      order({ orderId: "a", createdAt: "2026-11-11T10:00:00Z" }),
      order({ orderId: "b", status: "FILLED", createdAt: "2026-11-11T10:01:00Z" }),
      order({ orderId: "c", status: "PARTIALLY_FILLED", createdAt: "2026-11-11T10:02:00Z" }),
      order({ orderId: "d", symbol: "CRUX", status: "REJECTED", createdAt: "2026-11-11T10:03:00Z" }),
    ];
    const all = splitOrders(orders);
    expect(all.open.map((o) => o.orderId)).toEqual(["c", "a"]);
    expect(all.done.map((o) => o.orderId)).toEqual(["d", "b"]);
    expect(splitOrders(orders, "CRUX").done.map((o) => o.orderId)).toEqual(["d"]);
  });

  test("shares available to sell: held, less the rest of working sells", () => {
    const orders = [
      order({ side: "SELL", qty: 30, filledQty: 10 }), // 20 still promised
      order({ side: "SELL", qty: 50, status: "FILLED", filledQty: 50 }), // finished: not counted
      order({ side: "BUY", qty: 500 }),
    ];
    expect(availableToSell([holding({})], orders, "ACME")).toBe(80);
    expect(availableToSell([], orders, "ACME")).toBe(0);
    expect(sharesOwned([holding({}), holding({ symbol: "CRUX" })], "ACME")).toBe(100);
  });

  test("position value and P&L at a price, and without one", () => {
    expect(positionValue(holding({}), 4500)).toEqual({ qty: 100, marketValueCents: 450_000, pnlCents: 50_000, pnlBps: 1250 });
    expect(positionValue(holding({}), undefined).marketValueCents).toBeUndefined();
  });

  test("event lines", () => {
    const event = (type: string, detail: Record<string, unknown>): OrderEvent => ({ type, status: "NEW", execId: null, detail, at: "" });
    expect(eventText(event("PLACED", { reserved_cents: 421_000 }))).toBe("Accepted by the broker; $4,210.00 held back");
    expect(eventText(event("FILL", { qty: 40, price_cents: 4205, fee_cents: 5 }))).toBe("40 filled at 42.05, fee $0.05");
    expect(eventText(event("FILL", { qty: 40, price_cents: 4205, fee_cents: -2 }))).toBe("40 filled at 42.05, rebate $0.02");
    expect(eventText(event("REJECTED", { reason: "INSUFFICIENT_BUYING_POWER", text: "needs more" }))).toBe("Rejected: needs more");
    expect(eventText(event("SOMETHING_NEW", {}))).toBe("something new");
  });
});
