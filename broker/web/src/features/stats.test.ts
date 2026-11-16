// The live platform stats in the web app (ADR 0016): how numbers are written, what each
// group holds, the guide's arrow labels, the store, and which styles show the strip.

import { describe, expect, test } from "vitest";

import type { StatsMessage, StatsPoint } from "../api/marketData.ts";
import { HISTORY, StatsStore, mergeHistory, recentAverage } from "../market/stats.ts";
import { VARIANTS } from "../theme/variants.ts";
import { flowRates, formatStat, groups, updatesPerTrade } from "./stats/catalog.ts";

const sample = (ts: string, transactionsPerSec = 298): StatsMessage => ({
  type: "stats",
  ts,
  venue: {
    businessDate: "2026-11-17",
    transactionsPerSec,
    newOrdersPerSec: 150,
    cancelsPerSec: 148,
    rejectsPerSec: 0,
    tradesPerSec: 6,
    sharesPerSec: 1200,
    notionalCentsPerSec: 5_000_000,
    fixInPerSec: 300,
    fixOutPerSec: 320,
    feedMessagesPerSec: 310,
    answerP50Us: 5800,
    answerP99Us: 14_500,
    openOrders: 170,
    sessions: 2,
    transactionsToday: 9_000_000,
    tradesToday: 180_000,
  },
  marketData: { browsers: 4, feedMessagesInPerSec: 320, liveMessagesOutPerSec: 40, tradesStoredPerSec: 6, feedGaps: 0 },
});

describe("writing a stat", () => {
  test("rates, counts, money and times", () => {
    expect(formatStat("rate", 298.4)).toBe("298/s");
    expect(formatStat("rate", 6.25)).toBe("6.3/s");
    expect(formatStat("rate", 0)).toBe("0/s");
    expect(formatStat("count", 9_000_000)).toBe("9,000,000");
    expect(formatStat("money-rate", 5_000_000)).toBe("$50,000/s");
    expect(formatStat("micros", 5800)).toBe("5.8 ms");
    expect(formatStat("micros", 14_500)).toBe("15 ms");
    expect(formatStat("rate", null)).toBe("–");
  });

  test("order updates per trade, when there are trades", () => {
    expect(updatesPerTrade(sample("t").venue)).toBeCloseTo(49.7, 1);
    expect(updatesPerTrade({ ...sample("t").venue!, tradesPerSec: 0 })).toBeNull();
  });
});

describe("the dialog's groups", () => {
  test("the exchange, market data and the broker, each stat with words to explain it", () => {
    const all = groups(sample("t"), { venue: "ALPHA", connected: true, lastHeardAt: null, activity: { requestsPerSec: 2.5, ordersToday: 12, accounts: 30 } });
    expect(all.map((g) => g.title)).toEqual(["The exchange", "Market data", "The broker"]);
    for (const stat of all.flatMap((g) => g.stats)) {
      expect(stat.about.length, stat.id).toBeGreaterThan(20);
      expect(stat.value, stat.id).not.toBeNull();
    }
    // On screen it is an order update, never a "cancel".
    expect(all.flatMap((g) => g.stats.map((s) => s.label)).join(" ")).not.toMatch(/cancel/i);
  });

  test("before anything has arrived, every value is unknown", () => {
    const empty = groups(null, undefined).flatMap((g) => g.stats);
    expect(empty.every((s) => s.value === null)).toBe(true);
  });
});

describe("the guide's arrows", () => {
  test("labelled with what flows along them", () => {
    const rates = flowRates(sample("t"), { venue: "ALPHA", connected: true, lastHeardAt: null, activity: { requestsPerSec: 2.5, ordersToday: 12, accounts: 30 } });
    const full = Object.fromEntries([...rates].map(([key, label]) => [key, label.full]));
    expect(full).toEqual({
      "firms>exchange": "298/s order updates",
      "exchange>md": "310/s updates",
      "md>mddb": "6.0/s trades saved",
      "md>you": "10/s to each screen",
      "you>broker": "2.5/s requests",
      "broker>exchange": "12 orders today",
    });
    // Between boxes side by side, only the short form fits; it still has to mean something.
    expect(rates.get("firms>exchange")!.short).toBe("298/s");
    expect(rates.get("broker>exchange")!.short).toBe("12 today");
  });

  test("none while nothing is known", () => {
    expect(flowRates(null, undefined).size).toBe(0);
  });
});

describe("the stats store", () => {
  const point = (ts: string, tx: number | null): StatsPoint => ({ ts, transactionsPerSec: tx, tradesPerSec: 1, answerP99Us: 1, liveMessagesOutPerSec: 1 });

  test("the history joins seeded and live points by time, keeping five minutes", () => {
    const seeded = Array.from({ length: HISTORY }, (_, i) => point(String(1000 + i), i));
    const merged = mergeHistory(seeded, [point(String(1000 + HISTORY), 999)]);
    expect(merged).toHaveLength(HISTORY);
    expect(merged.at(-1)!.transactionsPerSec).toBe(999);
    expect(merged[0]!.transactionsPerSec).toBe(1);
  });

  test("the header's average skips seconds the exchange was silent", () => {
    expect(recentAverage([point("1", 100), point("2", null), point("3", 200)], "transactionsPerSec")).toBe(150);
    expect(recentAverage([], "transactionsPerSec")).toBeNull();
  });

  test("a live sample is not undone by an older seed arriving after it", () => {
    const store = new StatsStore();
    store.add(sample("2026-11-17T10:00:05Z", 300));
    store.seed(sample("2026-11-17T10:00:01Z", 100), [point("2026-11-17T10:00:01Z", 100)]);
    expect(store.get().latest?.venue?.transactionsPerSec).toBe(300);
    expect(store.get().history.map((p) => p.transactionsPerSec)).toEqual([100, 300]);
  });
});

test("the strip: four numbers in Terminal, three in Pro and Active, none in Calm", () => {
  expect(VARIANTS.terminal.statsStrip).toBe("full");
  expect(VARIANTS.pro.statsStrip).toBe("standard");
  expect(VARIANTS.active.statsStrip).toBe("standard");
  expect(VARIANTS.calm.statsStrip).toBe("none");
});
