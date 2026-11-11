import assert from "node:assert/strict";
import { test } from "node:test";

import { type QuoteInputs, desiredQuotes, halfSpread } from "../src/agents/market-maker.ts";

const base: QuoteInputs = {
  fairCents: 4210,
  volPerSec: 0.025 / Math.sqrt(86_400),
  inventory: 0,
  maxInventory: 1000,
  lot: 100,
  listing: { ticker: "ACME", tickCents: 1, referenceCents: 4210, bandPct: 20 },
};

const best = (inputs: QuoteInputs) => {
  const quotes = desiredQuotes(inputs).filter((q) => q.level === 0);
  return {
    bid: quotes.find((q) => q.side === "buy")?.priceCents,
    ask: quotes.find((q) => q.side === "sell")?.priceCents,
  };
};

test("quotes straddle fair value with three levels a side, deeper ones larger", () => {
  const quotes = desiredQuotes(base);
  assert.equal(quotes.length, 6);
  const { bid, ask } = best(base);
  assert.ok(bid! < 4210 && ask! > 4210, `${bid} / ${ask}`);
  const bids = quotes.filter((q) => q.side === "buy");
  assert.deepEqual(bids.map((q) => q.qty), [100, 200, 300]);
  assert.ok(bids[0]!.priceCents > bids[1]!.priceCents && bids[1]!.priceCents > bids[2]!.priceCents);
});

test("the spread never collapses below a tick, and widens with volatility", () => {
  const calm = { ...base, volPerSec: 0 };
  const { bid, ask } = best(calm);
  assert.ok(ask! - bid! >= 1);
  const wild = { ...base, volPerSec: base.volPerSec * 5 };
  assert.ok(halfSpread(wild) > 2 * halfSpread(base));
  const tick5 = { ...calm, fairCents: 28_650, listing: { ...base.listing, tickCents: 5 } };
  const quotes = desiredQuotes(tick5);
  assert.ok(quotes.every((q) => q.priceCents % 5 === 0), "every price is on a 5-cent tick");
});

test("holding stock shades both quotes down; being short shades them up", () => {
  const flat = best(base);
  const long = best({ ...base, inventory: 600 });
  const short = best({ ...base, inventory: -600 });
  assert.ok(long.bid! < flat.bid! && long.ask! < flat.ask!);
  assert.ok(short.bid! > flat.bid! && short.ask! > flat.ask!);
});

test("resting quotes on a side never add up to more than the room left", () => {
  const halfway = desiredQuotes({ ...base, inventory: 500 });
  const bids = halfway.filter((q) => q.side === "buy");
  assert.ok(bids.reduce((sum, q) => sum + q.qty, 0) <= 500, JSON.stringify(bids));
  assert.equal(halfway.filter((q) => q.side === "sell").length, 3, "the reducing side is untouched");
});

test("past the limit one lot stays at the touch, and past 1.5x the side goes", () => {
  const over = desiredQuotes({ ...base, inventory: 1200 });
  assert.deepEqual(
    over.filter((q) => q.side === "buy").map((q) => [q.level, q.qty]),
    [[0, 100]],
  );
  assert.ok(desiredQuotes({ ...base, inventory: 1500 }).every((q) => q.side === "sell"));
  assert.ok(desiredQuotes({ ...base, inventory: -1500 }).every((q) => q.side === "buy"));
});

test("however hard it leans, its own bid and offer never cross", () => {
  for (const inventory of [-1499, -1000, 0, 1000, 1499]) {
    const quotes = desiredQuotes({ ...base, inventory, volPerSec: 0 });
    const bid = Math.max(...quotes.filter((q) => q.side === "buy").map((q) => q.priceCents));
    const ask = Math.min(...quotes.filter((q) => q.side === "sell").map((q) => q.priceCents));
    assert.ok(bid < ask, `inventory ${inventory}: ${bid} / ${ask}`);
  }
});

test("quotes outside the venue's price band are not sent", () => {
  // Fair value pinned at the top of a 20% band: the offers would be outside it.
  const quotes = desiredQuotes({ ...base, fairCents: 5052 });
  assert.ok(quotes.every((q) => Math.abs(q.priceCents - 4210) * 100 <= 4210 * 20));
});
