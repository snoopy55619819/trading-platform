import assert from "node:assert/strict";
import { test } from "node:test";

import { type Exposure, type Limits, type OrderRequest, type Security, check, reservationCents, worstPriceCents } from "../src/oms/risk.ts";
import { isTerminal, transition } from "../src/oms/state.ts";

const crux: Security = { ticker: "CRUX", status: "ACTIVE", tickSizeCents: 5, lotSize: 1, referencePriceCents: 28_650, priceBandPct: 15 };
const limits: Limits = { maxOrderValueCents: 10_000_000, maxPositionQty: 1_000, maxOrdersPerMin: 10 };
const flush: Exposure = { cashCents: 5_000_000, reservedCents: 0, heldQty: 50, workingBuyQty: 0, workingSellQty: 0, ordersLastMinute: 0 };
const buy: OrderRequest = { symbol: "CRUX", side: "BUY", orderType: "LIMIT", timeInForce: "DAY", priceCents: 28_650, qty: 10 };

const reason = (request: OrderRequest, overrides: Partial<Exposure> = {}, security: Security | undefined = crux, up = true) => {
  const verdict = check(request, security, limits, { ...flush, ...overrides }, up);
  return verdict.ok ? "OK" : verdict.reason;
};

test("each rule rejects for its own reason", () => {
  assert.equal(reason(buy), "OK");
  // Not through reason(): passing undefined to a defaulted parameter gets the default.
  const unknown = check(buy, undefined, limits, flush, true);
  assert.equal(unknown.ok ? "OK" : unknown.reason, "UNKNOWN_SYMBOL");
  assert.equal(reason(buy, {}, { ...crux, status: "HALTED" }), "SYMBOL_HALTED");
  assert.equal(reason(buy, {}, { ...crux, lotSize: 100 }), "INVALID_LOT_SIZE");
  assert.equal(reason({ ...buy, priceCents: 28_652 }), "INVALID_TICK_SIZE");
  assert.equal(reason({ ...buy, priceCents: 33_000 }), "PRICE_OUT_OF_BAND");
  assert.equal(reason(buy, { ordersLastMinute: 10 }), "RATE_LIMIT_EXCEEDED");
  assert.equal(reason({ ...buy, qty: 400 }), "ORDER_VALUE_LIMIT_EXCEEDED");
  assert.equal(reason(buy, { heldQty: 995 }), "POSITION_LIMIT_EXCEEDED");
  assert.equal(reason(buy, { cashCents: 286_000 }), "INSUFFICIENT_BUYING_POWER");
  assert.equal(reason(buy, { reservedCents: 4_800_000 }), "INSUFFICIENT_BUYING_POWER", "reservations count");
  assert.equal(reason({ ...buy, side: "SELL", qty: 51 }), "INSUFFICIENT_POSITION");
  assert.equal(reason({ ...buy, side: "SELL", qty: 30 }, { workingSellQty: 25 }), "INSUFFICIENT_POSITION");
  assert.equal(reason({ ...buy, side: "SELL", qty: 25 }, { workingSellQty: 25 }), "OK");
  assert.equal(reason(buy, {}, crux, false), "VENUE_UNAVAILABLE");
});

test("the price band is inclusive at its edge", () => {
  const edge = 28_650 + Math.floor((28_650 * 15) / 100 / 5) * 5; // 32,945: on tick, inside
  assert.equal(reason({ ...buy, priceCents: edge }), "OK");
  assert.equal(reason({ ...buy, priceCents: edge + 5 }), "PRICE_OUT_OF_BAND");
});

test("a market buy reserves at the band ceiling, on tick, plus the worst fee", () => {
  const market: OrderRequest = { ...buy, orderType: "MARKET", priceCents: undefined };
  assert.equal(worstPriceCents(market, crux), 32_945);
  // 10 x 32,945 = 329,450, plus 3 bps rounded up = 99
  assert.equal(reservationCents(10, 32_945), 329_549);
  const verdict = check(market, crux, limits, flush, true);
  assert.deepEqual(verdict, { ok: true, reserveCents: 329_549 });
});

test("terminal statuses have no way out", () => {
  for (const status of ["FILLED", "CANCELED", "REJECTED", "EXPIRED"] as const) {
    assert.ok(isTerminal(status));
    for (const to of ["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "PENDING_CANCEL"] as const) {
      assert.throws(() => transition(status, to), /cannot go/);
    }
  }
  assert.equal(transition("PENDING_CANCEL", "FILLED"), "FILLED", "a fill can beat a cancel");
  assert.equal(transition("PENDING_CANCEL", "NEW"), "NEW", "a refused cancel returns to working");
});
