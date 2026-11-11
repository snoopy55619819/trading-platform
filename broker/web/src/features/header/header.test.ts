import { describe, expect, test } from "vitest";

import type { Security } from "../../api/backend.ts";
import type { Bar } from "../../api/marketData.ts";
import type { SymbolMarket } from "../../market/store.ts";
import { quoteFrom } from "./quote.ts";
import { matchSymbols } from "./search.ts";

const security = (symbol: string, name: string): Security => ({
  symbol, name, venue: "ALPHA", tickSizeCents: 1, lotSize: 1, status: "ACTIVE", referencePriceCents: 1000, priceBandPct: 20,
});
const symbols = [
  security("ACME", "Acme Industrial Corp"),
  security("BLTZ", "Blitzen Logistics Inc"),
  security("CRUX", "Crux Semiconductor Ltd"),
  security("GRID", "Gridline Utilities Corp"),
];

describe("symbol search", () => {
  test("an exact ticker first, then tickers starting with it, then names containing it", () => {
    // CRUX by ticker; then by name: Acme ("Corp"), Blitzen ("Inc"), Gridline ("Corp").
    expect(matchSymbols("c", symbols).map((s) => s.symbol)).toEqual(["CRUX", "ACME", "BLTZ", "GRID"]);
    expect(matchSymbols("cru", symbols).map((s) => s.symbol)).toEqual(["CRUX"]);
    expect(matchSymbols("GRID", symbols).map((s) => s.symbol)).toEqual(["GRID"]);
    expect(matchSymbols("logistics", symbols).map((s) => s.symbol)).toEqual(["BLTZ"]);
    expect(matchSymbols("", symbols, 2).map((s) => s.symbol)).toEqual(["ACME", "BLTZ"]);
    expect(matchSymbols("zzz", symbols)).toEqual([]);
  });
});

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
  test("change is against the previous business day's close, volume is today's", () => {
    const bars = [bar("2026-11-10T21:00:00.000Z", 4200, 900), bar("2026-11-11T21:00:00.000Z", 4230, 150)];
    const quote = quoteFrom(market(4250, 4249, 4251), bars, TODAY);
    expect(quote).toEqual({
      lastCents: 4250, bidCents: 4249, askCents: 4251, changeCents: 50, changeBps: 119, volume: 150, live: true,
    });
  });

  test("before today's first trade: the last close is the previous one, and volume is zero", () => {
    const bars = [bar("2026-11-09T21:00:00.000Z", 4100), bar("2026-11-10T21:00:00.000Z", 4200)];
    const quote = quoteFrom(market(undefined), bars, TODAY);
    expect(quote.lastCents).toBe(4200);
    expect(quote.changeCents).toBe(0);
    expect(quote.volume).toBe(0);
    expect(quote.live).toBe(false);
  });

  test("with no history at all there is no change to show", () => {
    const quote = quoteFrom(market(4250), [bar("2026-11-11T21:00:00.000Z", 4250)], TODAY);
    expect(quote.changeCents).toBeUndefined();
    expect(quote.lastCents).toBe(4250);
  });
});
