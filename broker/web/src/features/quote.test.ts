// The Quote section's numbers (src/features/quote/quote.ts): change against the previous
// close, and today's high, low and volume.

import { describe, expect, test } from "vitest";

import type { Bar } from "../api/marketData.ts";
import type { SymbolMarket } from "../market/store.ts";
import { quoteFrom } from "./quote/quote.ts";

const bar = (t: string, close: number, volume = 100): Bar => ({
  t, openCents: close, highCents: close, lowCents: close, closeCents: close, volume, trades: 1,
});
const market = (last?: number, bid?: number, ask?: number, live = true): SymbolMarket => ({
  lastPriceCents: last,
  trades: [],
  book: bid === undefined && ask === undefined ? undefined : {
    type: "book", symbol: "ACME", live,
    bids: bid === undefined ? [] : [{ priceCents: bid, qty: 1, orders: 1 }],
    asks: ask === undefined ? [] : [{ priceCents: ask, qty: 1, orders: 1 }],
  },
});
const TODAY = Date.parse("2026-11-11T21:00:00Z");

describe("quote", () => {
  test("high and low are today's, not the previous day's", () => {
    const bars = [
      { ...bar("2026-11-10T21:00:00.000Z", 4200), highCents: 4400, lowCents: 4000 },
      { ...bar("2026-11-11T21:00:00.000Z", 4230), highCents: 4260, lowCents: 4190 },
    ];
    const quote = quoteFrom(market(4250), bars, TODAY);
    expect([quote.highCents, quote.lowCents]).toEqual([4260, 4190]);
  });


  test("change is against the previous business day's close, volume is today's", () => {
    const bars = [bar("2026-11-10T21:00:00.000Z", 4200, 900), bar("2026-11-11T21:00:00.000Z", 4230, 150)];
    const quote = quoteFrom(market(4250, 4249, 4251), bars, TODAY);
    expect(quote).toEqual({
      lastCents: 4250, bidCents: 4249, askCents: 4251, changeCents: 50, changeBps: 119,
      highCents: 4230, lowCents: 4230, volume: 150, live: true,
    });
  });

  test("before today's first trade: the last close is the previous one, and volume is zero", () => {
    const bars = [bar("2026-11-09T21:00:00.000Z", 4100), bar("2026-11-10T21:00:00.000Z", 4200)];
    const quote = quoteFrom(market(undefined), bars, TODAY);
    expect(quote.lastCents).toBe(4200);
    expect(quote.changeCents).toBe(0);
    expect(quote.volume).toBe(0);
    expect(quote.highCents).toBeUndefined();
    expect(quote.lowCents).toBeUndefined();
    expect(quote.live).toBe(false);
  });

  test("with no history at all there is no change to show", () => {
    const quote = quoteFrom(market(4250), [bar("2026-11-11T21:00:00.000Z", 4250)], TODAY);
    expect(quote.changeCents).toBeUndefined();
    expect(quote.lastCents).toBe(4250);
  });
});
