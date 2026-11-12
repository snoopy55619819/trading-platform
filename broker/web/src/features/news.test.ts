// News in the web app (ADR 0006): stored and live headlines joined once, placed on the
// right candle, marked with the right tone, and timed in the viewer's zone.

import { describe, expect, test } from "vitest";

import type { Bar, NewsMessage } from "../api/marketData.ts";
import { DEFAULT_LAYOUTS } from "../layout/layouts.ts";
import { LIVE_NEWS, NewsStore, markerTone, mergeNews, newsOnBars } from "../market/news.ts";
import { when } from "./news/NewsPanel.tsx";

let n = 0;
const news = (symbol: string, ts: string, tone: NewsMessage["tone"] = "POSITIVE"): NewsMessage => ({
  type: "news",
  id: `01ZZZZZZZZZZZZZZZZZZZZ${String(++n).padStart(4, "0")}`,
  ts,
  symbol,
  headline: `${symbol} story ${n}`,
  body: "A story.",
  category: "EARNINGS_BEAT",
  tone,
  severity: "MINOR",
});
const bar = (t: string): Bar => ({ t, openCents: 100, highCents: 100, lowCents: 100, closeCents: 100, volume: 1, trades: 1 });

describe("news", () => {
  test("stored and live headlines join once, newest first, for one symbol or all", () => {
    const a = news("ACME", "2026-11-12T14:00:00.000Z");
    const b = news("GRID", "2026-11-12T14:01:00.000Z");
    const c = news("ACME", "2026-11-12T14:02:00.000Z");
    expect(mergeNews([c], [b, a, c], undefined, 10)).toEqual([c, b, a]);
    expect(mergeNews([c], [b, a], "ACME", 10)).toEqual([c, a]);
    expect(mergeNews([c], [b, a], undefined, 2)).toEqual([c, b]);
    expect(mergeNews([], [], undefined, 5)).toEqual([]);
  });

  test("a headline lands on the candle whose bucket holds its time", () => {
    const bars = [bar("2026-11-12T14:00:00.000Z"), bar("2026-11-12T14:01:00.000Z"), bar("2026-11-12T14:03:00.000Z")];
    const early = news("ACME", "2026-11-12T13:59:59.000Z"); // before the first bar
    const first = news("ACME", "2026-11-12T14:00:59.999Z");
    const second = news("ACME", "2026-11-12T14:01:30.000Z", "NEGATIVE");
    const secondLater = news("ACME", "2026-11-12T14:01:45.000Z", "NEUTRAL");
    const gap = news("ACME", "2026-11-12T14:02:10.000Z"); // a minute with no trades, so no bar
    expect(newsOnBars(bars, [secondLater, early, first, gap, second], "1m")).toEqual([
      { index: 0, headlines: [first] },
      { index: 1, headlines: [secondLater, second] },
    ]);
    // On an hourly chart they all share one candle.
    expect(newsOnBars([bar("2026-11-12T14:00:00.000Z")], [first, second], "1h")[0]?.headlines).toEqual([second, first]);
  });

  test("a candle's dot shows the newest moving story's tone, else neutral", () => {
    const t = "2026-11-12T14:00:00.000Z";
    expect(markerTone([news("ACME", t, "NEUTRAL"), news("ACME", t, "NEGATIVE"), news("ACME", t, "POSITIVE")])).toBe("NEGATIVE");
    expect(markerTone([news("ACME", t, "NEUTRAL")])).toBe("NEUTRAL");
  });

  test("the live store keeps each headline once, newest first, and tells its readers", () => {
    const store = new NewsStore();
    let told = 0;
    store.subscribe(() => (told += 1));
    const a = news("ACME", "2026-11-12T14:00:00.000Z");
    store.add(a);
    store.add(a);
    const b = news("GRID", "2026-11-12T14:01:00.000Z");
    store.add(b);
    expect(store.get()).toEqual([b, a]);
    expect(told).toBe(2);
    for (let i = 0; i < LIVE_NEWS + 5; i++) store.add(news("ACME", "2026-11-12T15:00:00.000Z"));
    expect(store.get()).toHaveLength(LIVE_NEWS);
  });

  test("times: today's show the time only, older ones the date as well", () => {
    const now = new Date(2026, 10, 12, 18, 0);
    expect(when(new Date(2026, 10, 12, 14, 3).toISOString(), now)).toMatch(/^14:03$/);
    expect(when(new Date(2026, 10, 11, 9, 5).toISOString(), now)).toMatch(/11.*09:05$/);
  });

  test("every style shows the news panel, on the desktop and on a phone", () => {
    for (const [style, layout] of Object.entries(DEFAULT_LAYOUTS)) {
      expect(layout.panels.map((p) => p.type), style).toContain("news");
      expect(layout.phone, style).toContain("news");
    }
  });
});
