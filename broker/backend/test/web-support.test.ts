// What the web client needs from the backend: cost basis on positions, a watchlist, the
// exchange connection's status, and CORS for the web client's origin.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { createApi } from "../src/api/server.ts";
import { type Db, createPool } from "../src/db.ts";
import type { Side } from "../src/domain/index.ts";
import { ulid } from "../src/ids.ts";
import { averageCost, costs, holdings, openAccount, postFill } from "../src/ledger/index.ts";
import { Oms } from "../src/oms/service.ts";
import { DEFAULT_WATCHLIST_SIZE, seedWatchlist, unwatch, watch, watchlist } from "../src/watchlist.ts";

const pool = createPool();
after(() => pool.end());

async function rolledBack(work: (db: Db) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const fill = (side: "BUY" | "SELL", qty: number, priceCents: number, feeCents: number, symbol = "ACME") =>
  ({ symbol, side, qty, notional_cents: qty * priceCents, fee_cents: feeCents });

// ---- cost basis ----

test("average cost: buys add cost with fees, a partial sell removes its share and realises the rest", () => {
  const acme = averageCost([
    fill("BUY", 100, 4200, 126), //   cost 420,126
    fill("BUY", 50, 4400, 66), //     cost 420,126 + 220,066 = 640,192 for 150
    fill("SELL", 30, 4500, 41), //    removes round(640,192 x 30/150) = 128,038
  ]).get("ACME")!;
  assert.equal(acme.qty, 120);
  assert.equal(acme.costBasisCents, 640_192 - 128_038);
  assert.equal(acme.avgCostCents, Math.round((640_192 - 128_038) / 120));
  // Proceeds 135,000 less the 41 fee, less the cost removed.
  assert.equal(acme.realizedPnlCents, 135_000 - 41 - 128_038);
});

test("selling out leaves exactly zero cost, and buying back starts afresh", () => {
  const fills = [fill("BUY", 3, 1001, 0), fill("SELL", 1, 1100, 0), fill("SELL", 2, 1200, 0)];
  const out = averageCost(fills).get("ACME")!;
  assert.equal(out.qty, 0);
  assert.equal(out.costBasisCents, 0, "no stray cent left behind by rounding");
  assert.equal(out.avgCostCents, null);
  // Paid 3,003; sold for 1,100 + 2,400: exactly 497 made.
  assert.equal(out.realizedPnlCents, 497);

  const again = averageCost([...fills, fill("BUY", 10, 900, 3)]).get("ACME")!;
  assert.equal(again.costBasisCents, 9_003);
  assert.equal(again.avgCostCents, 900);
  assert.equal(again.realizedPnlCents, 497, "earlier profit is kept");
});

test("a maker rebate lowers the cost", () => {
  const acme = averageCost([fill("BUY", 100, 4200, -84)]).get("ACME")!;
  assert.equal(acme.costBasisCents, 420_000 - 84);
});

test("cost basis from booked fills agrees with the ledger's quantities, in booking order", () =>
  rolledBack(async (db) => {
    const account = await openAccount(db, "test");
    const book = (side: Side, qty: number, priceCents: number) =>
      postFill(db, {
        fillId: ulid(), execId: ulid(), tradeId: ulid(), orderId: "o", accountId: account, venue: "ALPHA",
        symbol: "ACME", side, qty, priceCents, notionalCents: qty * priceCents, feeCents: 0, currency: "USD",
        transactTsNs: 0n, businessDate: "2026-11-11",
      });
    // Same timestamp on purpose: only the booking order can tell these apart.
    await book("BUY", 10, 1000);
    await book("SELL", 10, 1100);
    await book("BUY", 5, 2000);
    const acme = (await costs(db, account)).get("ACME")!;
    assert.deepEqual([acme.qty, acme.costBasisCents, acme.realizedPnlCents], [5, 10_000, 1_000]);
    const held = (await holdings(db, account))[0]!;
    assert.equal(held.qtySettled + held.qtyUnsettled, acme.qty);
  }));

// ---- watchlist ----

test("a watchlist starts with the active symbols up to the default size, keeps its order, and refuses what is not listed", () =>
  rolledBack(async (db) => {
    const account = await openAccount(db, "test");
    await seedWatchlist(db, account);
    const { rows } = await db.query<{ ticker: string }>(
      "SELECT ticker FROM broker.securities WHERE status = 'ACTIVE' ORDER BY ticker",
    );
    const all = rows.map((r) => r.ticker).slice(0, DEFAULT_WATCHLIST_SIZE);
    assert.ok(all.length > 5, "the seeded market has more than a handful of symbols");
    assert.deepEqual(await watchlist(db, account), all, "the active symbols in ticker order, up to the default size");

    const second = all[1]!;
    const without = all.filter((t) => t !== second);
    assert.deepEqual(await unwatch(db, account, second), without);
    const added = await watch(db, account, second);
    assert.deepEqual(added.ok && added.symbols, [...without, second], "added at the end");
    const twice = await watch(db, account, second);
    assert.deepEqual(twice.ok && twice.symbols.length, all.length, "adding it again changes nothing");
    assert.deepEqual(await watch(db, account, "NOPE"), { ok: false, reason: "UNKNOWN_SYMBOL" });
    assert.deepEqual(await unwatch(db, account, "NOPE"), [...without, second]);
  }));

// ---- status and CORS, over a real HTTP server ----

async function server() {
  const api = createApi(pool, new Oms(pool), "http://localhost:5173").listen(0);
  await new Promise((resolve) => api.once("listening", resolve));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  return { base, close: () => api.close() };
}

test("status says whether the exchange connection is up", async () => {
  const { base, close } = await server();
  const response = await fetch(`${base}/status`);
  assert.deepEqual(await response.json(), { venue: "ALPHA", connected: false });
  close();
});

test("CORS: the web client's origin is allowed, preflight included; any other origin is not", async () => {
  const { base, close } = await server();
  const web = "http://localhost:5173";

  const preflight = await fetch(`${base}/orders`, {
    method: "OPTIONS",
    headers: { origin: web, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), web);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /DELETE/);

  const real = await fetch(`${base}/status`, { headers: { origin: web } });
  assert.equal(real.headers.get("access-control-allow-origin"), web);
  assert.equal(real.headers.get("vary"), "Origin");

  const evil = "https://evil.example";
  const refused = await fetch(`${base}/orders`, { method: "OPTIONS", headers: { origin: evil } });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
  const readAnyway = await fetch(`${base}/status`, { headers: { origin: evil } });
  assert.equal(readAnyway.headers.get("access-control-allow-origin"), null, "a browser will not let that page read it");
  close();
});
