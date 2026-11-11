// The market sections' arithmetic: the book ladder, the chart's update-or-reset decision,
// the sparkline, and time and sales joining stored and live trades.

import { describe, expect, test } from "vitest";

import type { Bar, TradeMessage } from "../api/marketData.ts";
import { foldTrade } from "../market/candles.ts";
import { mergeTrades } from "../market/tape.ts";
import { ladder } from "./book/ladder.ts";
import { chartChange } from "./chart/updates.ts";
import { baselineY, sparklinePath, todaysCloses } from "./watchlist/sparkline.ts";

const level = (priceCents: number, qty: number) => ({ priceCents, qty, orders: 1 });

describe("book ladder", () => {
  test("asks highest first, bids best first, running totals, depth against the deeper side", () => {
    const l = ladder({ bids: [level(999, 100), level(998, 300)], asks: [level(1001, 50), level(1002, 150), level(1003, 600)] });
    expect(l.asks.map((r) => [r.priceCents, r.qty, r.total])).toEqual([
      [1003, 600, 800],
      [1002, 150, 200],
      [1001, 50, 50],
    ]);
    expect(l.bids.map((r) => [r.priceCents, r.total])).toEqual([
      [999, 100],
      [998, 400],
    ]);
    expect(l.asks[0]?.depth).toBe(1);
    expect(l.bids[1]?.depth).toBe(0.5);
    expect(l.spreadCents).toBe(2);
    expect(l.midCents).toBe(1000);
  });

  test("keeps at most `depth` levels a side; one side empty has no spread", () => {
    const bids = Array.from({ length: 15 }, (_, i) => level(1000 - i, 10));
    const l = ladder({ bids, asks: [] }, 10);
    expect(l.bids).toHaveLength(10);
    expect(l.bids.at(-1)?.total).toBe(100);
    expect(l.spreadCents).toBeUndefined();
    expect(l.midCents).toBeUndefined();
  });
});

const bar = (t: string, closeCents: number): Bar => ({
  t,
  openCents: closeCents,
  highCents: closeCents,
  lowCents: closeCents,
  closeCents,
  volume: 10,
  trades: 1,
});
const trade = (ts: string, priceCents: number, tradeId = ts): TradeMessage => ({
  type: "trade",
  symbol: "ACME",
  priceCents,
  qty: 5,
  aggressor: "BUY",
  ts,
  tradeId,
});

describe("chart changes", () => {
  const history = [bar("2026-11-11T10:00:00.000Z", 100), bar("2026-11-11T10:01:00.000Z", 101)];

  test("a trade in the last bar updates only that bar", () => {
    const next = foldTrade(history, trade("2026-11-11T10:01:30Z", 105), "1m");
    expect(chartChange(history, next)).toEqual({ kind: "update", bars: [next[1]] });
  });

  test("a trade opening a bar updates the old last bar and adds the new one", () => {
    const next = foldTrade(history, trade("2026-11-11T10:02:05Z", 99), "1m");
    const change = chartChange(history, next);
    expect(change.kind).toBe("update");
    expect(change.kind === "update" && change.bars.map((b) => b.t)).toEqual(["2026-11-11T10:01:00.000Z", "2026-11-11T10:02:00.000Z"]);
  });

  test("a refetch, first draw, or the same array", () => {
    const refetched = history.map((b) => ({ ...b }));
    expect(chartChange(history, refetched)).toEqual({ kind: "reset" });
    expect(chartChange(undefined, history)).toEqual({ kind: "reset" });
    expect(chartChange([], history)).toEqual({ kind: "reset" });
    expect(chartChange(history, history)).toEqual({ kind: "none" });
    expect(chartChange(history, [...history, bar("2026-11-11T10:02:00Z", 1), bar("2026-11-11T10:03:00Z", 1)])).toEqual({ kind: "reset" });
  });
});

describe("sparkline", () => {
  test("spread across the width, high at the top", () => {
    expect(sparklinePath([100, 200, 150], 10, 20)).toBe("M0,20 L5,0 L10,10");
  });

  test("the previous close stays in view", () => {
    // All above a baseline of 0: the line is in the top half, the baseline at the bottom.
    expect(sparklinePath([100, 200], 10, 20, 0)).toBe("M0,10 L10,0");
    expect(baselineY([100, 200], 20, 0)).toBe(20);
  });

  test("flat and too short", () => {
    expect(sparklinePath([5, 5, 5], 10, 20)).toBe("M0,10 L5,10 L10,10");
    expect(sparklinePath([5], 10, 20)).toBeUndefined();
    expect(sparklinePath([], 10, 20)).toBeUndefined();
  });

  test("only today's closes", () => {
    const bars = [bar("2026-11-10T20:55:00Z", 1), bar("2026-11-10T21:00:00Z", 2), bar("2026-11-10T21:05:00Z", 3)];
    expect(todaysCloses(bars, Date.parse("2026-11-10T21:00:00Z"))).toEqual([2, 3]);
    expect(todaysCloses(undefined, 0)).toEqual([]);
  });
});

describe("time and sales", () => {
  test("live and stored joined newest first, each trade once, capped", () => {
    const stored = [trade("2026-11-11T10:00:02Z", 102, "b"), trade("2026-11-11T10:00:01Z", 101, "a")];
    const live = [trade("2026-11-11T10:00:03Z", 103, "c"), trade("2026-11-11T10:00:02Z", 102, "b")];
    expect(mergeTrades(live, stored, 10).map((t) => t.tradeId)).toEqual(["c", "b", "a"]);
    expect(mergeTrades(live, stored, 2).map((t) => t.tradeId)).toEqual(["c", "b"]);
    expect(mergeTrades([], [], 5)).toEqual([]);
  });
});
