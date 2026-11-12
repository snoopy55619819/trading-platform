// The data layer against the real services: run with everything up (the exchange, the
// simulator for liquidity, the backend and market-data):
//
//     LIVE=1 pnpm test
//
// Skipped otherwise. Exercises exactly the clients the browser uses.

import { describe, expect, test } from "vitest";

import { backend } from "./api/backend.ts";
import { LiveFeed, fetchHistory } from "./api/marketData.ts";
import { session } from "./api/session.ts";
import { MarketStore } from "./market/store.ts";
import { newClientOrderId } from "./query/hooks.ts";

const live = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LIVE === "1";

describe.skipIf(!live)("against the running services", () => {
  test("sign up (with opening cash), fund, buy, and see the holding with its cost", async () => {
    const email = `web-live-${Date.now()}@example.com`;
    await backend.signUp(email, "correct horse", "Live test");
    session.start((await backend.logIn(email, "correct horse")).token);
    expect((await backend.status()).connected).toBe(true);
    expect(await backend.watchlist()).toHaveLength(5);

    expect((await backend.positions()).cashCents).toBe(1_000_000); // every new account starts with $10,000.00
    await backend.deposit(5_000_000, "opening");
    const order = await backend.placeOrder({
      clientOrderId: newClientOrderId(), symbol: "ACME", side: "BUY", orderType: "MARKET", timeInForce: "IOC", qty: 10,
    });
    expect(order.status).toBe("PENDING_NEW");

    let filled = order;
    for (let i = 0; i < 20 && filled.status !== "FILLED"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      filled = await backend.order(order.orderId);
    }
    expect(filled.status).toBe("FILLED");

    const positions = await backend.positions();
    const acme = positions.holdings.find((h) => h.symbol === "ACME")!;
    expect(acme.qtySettled + acme.qtyUnsettled).toBe(10);
    expect(acme.costBasisCents).toBe(filled.filledNotionalCents + filled.feeCents);
    expect(positions.cashCents).toBe(6_000_000 - acme.costBasisCents);
    session.end();
  }, 20_000);

  test("history, and the live feed filling the store", async () => {
    const bars = await fetchHistory("ACME", "1m", 60);
    expect(Array.isArray(bars)).toBe(true);

    const store = new MarketStore();
    const feed = new LiveFeed({ url: "ws://localhost:8081/live", onMessage: (m) => store.apply(m) });
    store.attach(feed);
    store.want("ACME");
    feed.start();
    for (let i = 0; i < 40 && !store.get("ACME").book; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    feed.stop();
    const book = store.get("ACME").book!;
    expect(book.live).toBe(true);
    expect(book.bids.length + book.asks.length).toBeGreaterThan(0);
  }, 10_000);
});
