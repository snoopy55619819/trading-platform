// Patient limit traders (agents/patient.ts): resting orders behind the best prices, at
// varied distances and sizes, with the odd far outlier and the odd block.

import assert from "node:assert/strict";
import { test } from "node:test";

import { patientOrder } from "../src/agents/patient.ts";
import { withinBand } from "../src/market/fair-value.ts";
import { Rng } from "../src/market/rng.ts";

const ACME = { ticker: "ACME", tickCents: 1, referenceCents: 4210, bandPct: 20 };
const book = { bestBid: 4208, bestAsk: 4212 };

function many(n: number, held = 0, seed = 1) {
  const rng = new Rng(seed);
  return Array.from({ length: n }, () => patientOrder(book, ACME, held, rng)!).filter(Boolean);
}

test("never crosses: bids rest below the best bid, offers above the best offer", () => {
  for (const o of many(5000)) {
    if (o.side === "buy") assert.ok(o.priceCents < book.bestBid, `${o.priceCents}`);
    else assert.ok(o.priceCents > book.bestAsk, `${o.priceCents}`);
    assert.ok(withinBand(o.priceCents, ACME));
    assert.ok(o.qty >= 1 && Number.isInteger(o.qty));
  }
});

test("many prices: most near the touch, some far out", () => {
  const orders = many(5000);
  const away = orders.map((o) => Math.abs(o.priceCents - (o.side === "buy" ? book.bestBid : book.bestAsk)) / 4210);
  const prices = new Set(orders.map((o) => o.priceCents));
  assert.ok(prices.size > 60, `${prices.size} distinct prices`);
  const median = [...away].sort((a, b) => a - b)[away.length >> 1]!;
  assert.ok(median > 0.001 && median < 0.004, `median ${median}`);
  // Outliers: a few percent of orders are over 1.5% away.
  const far = away.filter((d) => d > 0.015).length / away.length;
  assert.ok(far > 0.02 && far < 0.12, `far share ${far}`);
});

test("sizes vary, with the odd block", () => {
  const sizes = many(5000).map((o) => o.qty).sort((a, b) => a - b);
  const median = sizes[sizes.length >> 1]!;
  assert.ok(sizes.at(-1)! > 8 * median, `largest ${sizes.at(-1)} vs median ${median}`);
  assert.ok(new Set(sizes).size > 50);
});

test("both sides, leaning toward shrinking what it holds", () => {
  const buys = (held: number) => many(4000, held).filter((o) => o.side === "buy").length / 4000;
  assert.ok(Math.abs(buys(0) - 0.5) < 0.03);
  assert.ok(buys(10_000) < 0.3, "long: mostly sells");
  assert.ok(buys(-10_000) > 0.7, "short: mostly buys");
});
