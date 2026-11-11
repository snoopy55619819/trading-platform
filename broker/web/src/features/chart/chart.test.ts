// The chart's choices: which interval can show a range, which range suits an interval, how
// many bars to fetch, where the view starts, and what the legend says about a candle.

import { describe, expect, test } from "vitest";

import { INTERVALS, MAX_BARS, type Bar } from "../../api/marketData.ts";
import { legendFor } from "./legend.ts";
import { RANGES, RIGHT_OFFSET, barsToFetch, fits, frame, intervalForRange, rangeForInterval } from "./range.ts";

describe("range and interval", () => {
  test("a range fits an interval within the bar cap and with enough candles to read", () => {
    expect(fits("6H", "1m")).toBe(true); // 360 bars
    expect(fits("1D", "1m")).toBe(false); // 1440, over the cap
    expect(fits("1H", "1h")).toBe(false); // one candle
    expect(fits("All", "1m")).toBe(true);
  });

  test("every range has some interval that fits it, and every interval some range", () => {
    for (const range of RANGES) expect(INTERVALS.some((i) => fits(range, i))).toBe(true);
    for (const interval of INTERVALS) expect(RANGES.some((r) => r !== "All" && fits(r, interval))).toBe(true);
  });

  test("picking a range keeps the interval if it fits, else takes the finest that does", () => {
    expect(intervalForRange("6H", "5m")).toBe("5m");
    expect(intervalForRange("1D", "1m")).toBe("5m");
    expect(intervalForRange("1M", "1m")).toBe("1h");
    expect(intervalForRange("1Y", "5m")).toBe("1d");
    expect(intervalForRange("1H", "1d")).toBe("1m");
    expect(intervalForRange("All", "1h")).toBe("1h");
  });

  test("picking an interval keeps the range if it fits, else takes the nearest that does", () => {
    expect(rangeForInterval("5m", "1D")).toBe("1D");
    expect(rangeForInterval("1m", "1D")).toBe("6H");
    expect(rangeForInterval("1m", "1Y")).toBe("6H");
    expect(rangeForInterval("1d", "1H")).toBe("5D");
    expect(rangeForInterval("1h", "1H")).toBe("6H");
    expect(rangeForInterval("1d", "All")).toBe("All");
  });

  test("bars to fetch: twice the range, at least the usual 300, never past the cap", () => {
    expect(barsToFetch("1H", "1m")).toBe(300);
    expect(barsToFetch("6H", "1m")).toBe(720);
    expect(barsToFetch("1M", "1h")).toBe(MAX_BARS);
    expect(barsToFetch("All", "5m")).toBe(MAX_BARS);
  });
});

const minute = (i: number) => ({ t: new Date(Date.UTC(2026, 10, 11, 12, 0) + i * 60_000).toISOString() });

describe("frame", () => {
  test("starts at the first bar inside the range and ends past the latest", () => {
    const bars = Array.from({ length: 200 }, (_, i) => minute(i));
    // An hour of one-minute bars ending with the latest: the last 60.
    expect(frame(bars, "1H", "1m")).toEqual({ from: 140, to: 199 + RIGHT_OFFSET });
    expect(frame(bars, "All", "1m")).toEqual({ from: 0, to: 199 + RIGHT_OFFSET });
    // More range than history: everything.
    expect(frame(bars, "6H", "1m")?.from).toBe(0);
  });

  test("sparse trading: a range with few bars still shows a readable handful", () => {
    const bars = [...Array.from({ length: 30 }, (_, i) => minute(i)), minute(300), minute(301)];
    expect(frame(bars, "1H", "1m")).toEqual({ from: 22, to: 31 + RIGHT_OFFSET });
  });

  test("no bars, no frame", () => {
    expect(frame([], "1H", "1m")).toBeUndefined();
  });
});

const candle = (openCents: number, closeCents: number): Bar => ({
  t: "2026-11-11T12:00:00.000Z",
  openCents,
  highCents: Math.max(openCents, closeCents) + 5,
  lowCents: Math.min(openCents, closeCents) - 5,
  closeCents,
  volume: 12_345,
  trades: 3,
});

describe("legend", () => {
  test("prices from cents, volume grouped, change signed against the open", () => {
    expect(legendFor(candle(4200, 4250))).toEqual({
      open: "42.00",
      high: "42.55",
      low: "41.95",
      close: "42.50",
      volume: "12,345",
      change: "+0.50 (+1.19%)",
      direction: "up",
    });
  });

  test("a falling candle is down, an unchanged one flat", () => {
    expect(legendFor(candle(4250, 4200))).toMatchObject({ change: "-0.50 (-1.18%)", direction: "down" });
    expect(legendFor(candle(4200, 4200))).toMatchObject({ change: "0.00 (0.00%)", direction: "flat" });
  });
});
