import assert from "node:assert/strict";
import { test } from "node:test";

import { type Context, Positions } from "../src/agents/context.ts";
import { MarketMaker, type QuoteInputs, desiredQuotes, halfSpread } from "../src/agents/market-maker.ts";
import { profileFor } from "../src/config.ts";
import { FixMessage } from "../src/fix/codec.ts";
import { MsgType, Tag } from "../src/fix/tags.ts";
import { FairValue } from "../src/market/fair-value.ts";
import { Rng } from "../src/market/rng.ts";
import { Orders, RateLimit } from "../src/orders.ts";

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

/** Runs one market maker for `seconds` with fair value held still, the exchange acking
 * everything at once; returns how many orders and cancels it sent after its first quotes. */
function messagesWhileStill(quoteActivity: number, seconds: number): number {
  const sent: FixMessage[] = [];
  const orders = new Orders((m) => (sent.push(m), true), new RateLimit(1e9, 0), () => {});
  const listing = base.listing;
  const fair = new FairValue(listing, profileFor("ACME"));
  const context = {
    listings: new Map([["ACME", listing]]),
    fair: new Map([["ACME", fair]]),
    feed: undefined as never,
    orders,
    positions: new Positions(),
    rng: new Rng(7),
    activity: 1,
    quoteActivity,
  } satisfies Context;
  const maker = new MarketMaker("ACME", context);
  let acked = 0;
  let after = 0;
  for (let step = 0; step < seconds * 4; step++) {
    maker.step(step * 250, 0.25);
    // The exchange answers every new order and cancel straight away.
    for (const message of sent.slice(acked)) {
      const id = message.get(Tag.ClOrdID)!;
      const report = new FixMessage(MsgType.ExecutionReport).set(Tag.ClOrdID, id).set(Tag.OrderID, `O-${id}`);
      if (message.type === MsgType.NewOrderSingle) {
        orders.receive(report.set(Tag.ExecType, "0").set(Tag.OrdStatus, "0").set(Tag.LeavesQty, message.get(Tag.OrderQty)!));
      } else {
        const original = message.get(Tag.OrigClOrdID)!;
        orders.receive(report.set(Tag.OrderID, `O-${original}`).set(Tag.ExecType, "4").set(Tag.OrdStatus, "4").set(Tag.LeavesQty, "0"));
      }
    }
    acked = sent.length;
    if (step === 0) after = sent.length; // its first quotes
  }
  return sent.length - after;
}

test("with fair value still, quotes are re-priced only as often as the quote activity says", () => {
  assert.equal(messagesWhileStill(0, 120), 0, "nothing moves, nothing is sent");
  // Six quotes, each re-priced (a cancel and an order) about every 30 s at 1: about 48 in
  // two minutes; ten times that at 10.
  const one = messagesWhileStill(1, 120);
  const ten = messagesWhileStill(10, 120);
  assert.ok(one > 20 && one < 90, `at 1: ${one}`);
  assert.ok(ten > 6 * one && ten < 14 * one, `at 10: ${ten} against ${one}`);
});
