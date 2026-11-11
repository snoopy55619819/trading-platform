import { describe, expect, test, vi } from "vitest";

import { type Bar, type BookMessage, LiveFeed, type TradeMessage } from "../api/marketData.ts";
import { pollInterval } from "../query/hooks.ts";
import { bucketStart, foldTrade } from "./candles.ts";
import { MarketStore, RECENT_TRADES } from "./store.ts";

const book = (symbol: string, bid: number): BookMessage => ({
  type: "book", symbol, live: true, bids: [{ priceCents: bid, qty: 100, orders: 1 }], asks: [],
});
const trade = (symbol: string, priceCents: number, ts: string, qty = 10): TradeMessage => ({
  type: "trade", symbol, priceCents, qty, aggressor: "BUY", ts, tradeId: ts,
});

describe("market store", () => {
  test("a snapshot stays the same object until its symbol changes", () => {
    const store = new MarketStore();
    const empty = store.get("ACME");
    expect(store.get("ACME")).toBe(empty);
    store.apply(book("ACME", 4200));
    const first = store.get("ACME");
    expect(first).not.toBe(empty);
    expect(store.get("ACME")).toBe(first);
    store.apply(book("GRID", 3300));
    expect(store.get("ACME")).toBe(first); // another symbol's update leaves it alone
  });

  test("only the changed symbol's listeners are told", () => {
    const store = new MarketStore();
    const acme = vi.fn();
    const grid = vi.fn();
    store.subscribe("ACME", acme);
    store.subscribe("GRID", grid);
    store.apply(trade("ACME", 4200, "2026-11-11T10:00:00Z"));
    expect(acme).toHaveBeenCalledTimes(1);
    expect(grid).not.toHaveBeenCalled();
  });

  test("trades are kept newest first, capped, and set the last price", () => {
    const store = new MarketStore();
    for (let i = 0; i < RECENT_TRADES + 5; i++) store.apply(trade("ACME", 4000 + i, `2026-11-11T10:00:${String(i % 60).padStart(2, "0")}Z`));
    const acme = store.get("ACME");
    expect(acme.trades).toHaveLength(RECENT_TRADES);
    expect(acme.trades[0]?.priceCents).toBe(4000 + RECENT_TRADES + 4);
    expect(acme.lastPriceCents).toBe(4000 + RECENT_TRADES + 4);
  });

  test("the feed is subscribed for the first interested component and released by the last", () => {
    const store = new MarketStore();
    const feed = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    store.attach(feed);
    const releaseA = store.want("ACME");
    const releaseB = store.want("ACME");
    expect(feed.subscribe).toHaveBeenCalledTimes(1);
    releaseA();
    releaseA(); // releasing twice counts once
    expect(feed.unsubscribe).not.toHaveBeenCalled();
    releaseB();
    expect(feed.unsubscribe).toHaveBeenCalledWith("ACME");
  });

  test("a dropped feed marks live books stale", () => {
    const store = new MarketStore();
    store.apply(book("ACME", 4200));
    store.markAllStale();
    expect(store.get("ACME").book?.live).toBe(false);
  });
});

describe("candles", () => {
  test("buckets align to UTC, and days to the 21:00 UTC business-day roll", () => {
    const at = Date.parse("2026-11-11T20:58:40Z");
    expect(new Date(bucketStart(at, "1m")).toISOString()).toBe("2026-11-11T20:58:00.000Z");
    expect(new Date(bucketStart(at, "5m")).toISOString()).toBe("2026-11-11T20:55:00.000Z");
    expect(new Date(bucketStart(at, "1d")).toISOString()).toBe("2026-11-10T21:00:00.000Z");
    expect(new Date(bucketStart(Date.parse("2026-11-11T21:00:05Z"), "1d")).toISOString()).toBe("2026-11-11T21:00:00.000Z");
  });

  test("a trade updates the current bar, opens the next, and is ignored if older", () => {
    const bars: Bar[] = [{ t: "2026-11-11T10:00:00.000Z", openCents: 4200, highCents: 4210, lowCents: 4190, closeCents: 4205, volume: 100, trades: 4 }];
    const same = foldTrade(bars, trade("ACME", 4220, "2026-11-11T10:00:40Z", 5), "1m");
    expect(same).toEqual([{ ...bars[0], highCents: 4220, closeCents: 4220, volume: 105, trades: 5 }]);
    expect(bars[0]?.highCents).toBe(4210); // not mutated

    const next = foldTrade(same, trade("ACME", 4180, "2026-11-11T10:01:02Z", 7), "1m");
    expect(next.at(-1)).toEqual({ t: "2026-11-11T10:01:00.000Z", openCents: 4180, highCents: 4180, lowCents: 4180, closeCents: 4180, volume: 7, trades: 1 });

    expect(foldTrade(next, trade("ACME", 1, "2026-11-11T09:59:00Z"), "1m")).toBe(next);
  });
});

describe("live feed", () => {
  /** A stand-in WebSocket the test drives by hand. */
  class FakeSocket {
    static instances: FakeSocket[] = [];
    readyState = 0;
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      FakeSocket.instances.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
  }

  test("subscribes on open, resubscribes after a reconnect, and delivers messages", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    FakeSocket.instances = [];
    const messages: unknown[] = [];
    const states: string[] = [];
    const feed = new LiveFeed({
      url: "ws://test/live",
      onMessage: (m) => messages.push(m),
      onState: (s) => states.push(s),
      createSocket: () => new FakeSocket() as unknown as WebSocket,
    });
    feed.subscribe("ACME"); // before connecting: remembered
    feed.start();
    const first = FakeSocket.instances[0]!;
    first.open();
    expect(first.sent).toEqual([{ subscribe: ["ACME"] }]);
    feed.subscribe("GRID");
    expect(first.sent.at(-1)).toEqual({ subscribe: ["GRID"] });
    first.onmessage?.({ data: JSON.stringify(book("ACME", 4200)) });
    expect(messages).toHaveLength(1);

    first.close(); // the line drops
    vi.advanceTimersByTime(1000);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.sent).toEqual([{ subscribe: ["ACME", "GRID"] }]);
    expect(states).toEqual(["connecting", "open", "closed", "connecting", "open"]);

    feed.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2); // stopped means no reconnect
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

describe("polling", () => {
  test("fast while any order is working, slow otherwise", () => {
    const order = (status: string) => ({ status }) as never;
    expect(pollInterval(undefined)).toBe(5000);
    expect(pollInterval([order("FILLED"), order("REJECTED")])).toBe(5000);
    expect(pollInterval([order("FILLED"), order("PENDING_NEW")])).toBe(1000);
  });
});
