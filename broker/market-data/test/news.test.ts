// News from the newswire (ADR 0006): checked against its spec, stored once, served newest
// first, and pushed to every browser exactly once, even when a catch-up repeats a live
// headline. Database tests run in rolled-back transactions; the subscriber test talks to a
// stand-in newswire and removes what it stored.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { WebSocketServer } from "ws";

import { type Db, createPool } from "../src/db.ts";
import { Fanout } from "../src/live/fanout.ts";
import { NewsSubscriber } from "../src/news/subscriber.ts";
import { type Headline, checkHeadline, insertHeadline, newestHeadlineTs, recentNews } from "../src/store/news.ts";

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

let n = 0;
/** A headline far in the future, so it sorts after anything real in the database. */
function headline(symbol: string, minute: number, tone: Headline["tone"] = "POSITIVE"): Headline {
  n += 1;
  return {
    id: `01ZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(4, "0")}`,
    ts: new Date(Date.UTC(2099, 0, 1, 12, minute)).toISOString(),
    symbol,
    headline: `${symbol} story ${n}`,
    body: `The story about ${symbol}, number ${n}.`,
    category: tone === "NEUTRAL" ? "CONFERENCE" : "EARNINGS_BEAT",
    tone,
    severity: "MINOR",
  };
}

test("a headline is checked against the newswire's spec", () => {
  const good = headline("ACME", 0);
  assert.deepEqual(checkHeadline(good, ["ACME"]), good);
  assert.deepEqual(checkHeadline({ ...good, category: "SOMETHING_NEW" }, ["ACME"]), { ...good, category: "SOMETHING_NEW" },
    "a category we do not know is accepted, as the spec asks");
  assert.equal((checkHeadline({ ...good, ts: "2099-01-01T12:00:00Z" }, ["ACME"]) as Headline).ts, "2099-01-01T12:00:00.000Z",
    "times are stored and served in one form");
  assert.match(String(checkHeadline({ ...good, id: "nope" }, ["ACME"])), /id/);
  assert.match(String(checkHeadline({ ...good, symbol: "ZZZZ" }, ["ACME"])), /not listed/);
  assert.match(String(checkHeadline({ ...good, tone: "HAPPY" }, ["ACME"])), /tone/);
  assert.match(String(checkHeadline({ ...good, severity: "HUGE" }, ["ACME"])), /severity/);
  assert.match(String(checkHeadline({ ...good, headline: "" }, ["ACME"])), /headline/);
  assert.match(String(checkHeadline({ ...good, body: 42 }, ["ACME"])), /body/);
  const { body: _, ...withoutBody } = good;
  assert.deepEqual(checkHeadline(withoutBody, ["ACME"]), withoutBody, "a 1.0.0 headline, with no body, is fine");
  assert.match(String(checkHeadline("text", ["ACME"])), /object/);
});

test("stored once, served newest first, for one symbol or all", () =>
  rolledBack(async (db) => {
    const a = headline("ACME", 1);
    const b = headline("GRID", 2, "NEUTRAL");
    const c = headline("ACME", 3, "NEGATIVE");
    assert.equal(await insertHeadline(db, a), true);
    assert.equal(await insertHeadline(db, a), false, "the same id again");
    await insertHeadline(db, b);
    await insertHeadline(db, c);
    assert.deepEqual(await recentNews(db, "ACME", 2), [c, a], "ours sort after anything real: they are in 2099");
    assert.deepEqual((await recentNews(db, undefined, 2)).map((h) => h.id), [c.id, b.id]);
    assert.equal(await newestHeadlineTs(db), c.ts);

    // One without a story (a 1.0.0 newswire) comes back without a body field at all.
    const { body: _, ...d } = headline("ACME", 4);
    await insertHeadline(db, d);
    assert.deepEqual((await recentNews(db, "ACME", 1))[0], d);
  }));

test("every browser gets news, whatever symbols it watches", async () => {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const fanout = new Fanout(http, () => new Map());
  const socket = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/live`);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const received = new Promise<unknown>((resolve) => socket.addEventListener("message", (e) => resolve(JSON.parse(String(e.data)))));
  const h = headline("ACME", 4);
  fanout.news(h);
  assert.deepEqual(await received, { type: "news", ...h });
  socket.close();
  fanout.close();
  http.close();
});

test("the subscriber catches up, drops what it has, and passes each story on once", async () => {
  const kept = [headline("ACME", 10), headline("GRID", 11, "NEUTRAL")];
  const live = headline("ACME", 12, "NEGATIVE");
  const asked: string[] = [];
  // A stand-in newswire: catch-up returns `kept`, and every connection is sent kept[1] (a
  // repeat of a catch-up headline) and then `live`.
  const wire = createServer((req, res) => {
    asked.push(new URL(req.url ?? "/", "http://x").searchParams.get("since") ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ headlines: kept }));
  });
  const sockets = new WebSocketServer({ server: wire, path: "/headlines" });
  sockets.on("connection", (socket) => {
    setTimeout(() => {
      socket.send(JSON.stringify(kept[1]));
      socket.send(JSON.stringify(live));
      socket.send("not json");
    }, 50);
  });
  await new Promise<void>((resolve) => wire.listen(0, resolve));
  const url = `ws://127.0.0.1:${(wire.address() as AddressInfo).port}/headlines`;

  const passedOn: string[] = [];
  const subscriber = new NewsSubscriber(url, pool, ["ACME", "GRID"], (h) => passedOn.push(h.id));
  try {
    subscriber.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await subscriber.settled();
    assert.deepEqual([...passedOn].sort(), [...kept, live].map((h) => h.id).sort(), "each story once");
    assert.equal(subscriber.stats.stored, 3);
    assert.equal(subscriber.stats.rejected, 1, "the message that was not JSON");
    assert.equal(asked.length, 1);
    assert.deepEqual((await recentNews(pool, "ACME", 2)).map((h) => h.id), [live.id, kept[0]!.id]);
  } finally {
    subscriber.stop();
    sockets.close();
    wire.close();
    await pool.query("DELETE FROM market_data.news WHERE id = ANY($1)", [[...kept, live].map((h) => h.id)]);
  }
});
