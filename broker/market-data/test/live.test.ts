// The feed mirror's rules, and the browser fanout's conflation and slow-client policy.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { type FeedMessage, FeedMessageSchema } from "../gen/marketdata_pb.js";
import { Mirror } from "../src/feed/mirror.ts";
import { Fanout } from "../src/live/fanout.ts";

const snapshot = (symbolSeq: bigint, bid: bigint): FeedMessage =>
  create(FeedMessageSchema, {
    payload: { case: "snapshot", value: { symbol: "ACME", symbolSeq, bids: [{ priceCents: bid, qty: 100n, orderCount: 1 }] } },
  });
const delta = (symbolSeq: bigint, priceCents: bigint, qty: bigint): FeedMessage =>
  create(FeedMessageSchema, { payload: { case: "bookDelta", value: { symbol: "ACME", symbolSeq, side: 1, priceCents, qty } } });

test("the mirror waits for a snapshot, applies the next number, and goes stale on a gap", () => {
  const mirror = new Mirror("ACME");
  assert.equal(mirror.apply(delta(1n, 4200n, 5n)).kind, "ignored");
  mirror.apply(snapshot(4n, 4200n));
  assert.equal(mirror.apply(delta(4n, 4300n, 5n)).kind, "ignored", "already in the snapshot");
  assert.equal(mirror.apply(delta(5n, 4201n, 7n)).kind, "level");
  assert.deepEqual(mirror.book(1).bids, [{ priceCents: 4201, qty: 7, orders: 0 }]);
  assert.deepEqual(mirror.apply(delta(7n, 4202n, 1n)), { kind: "gap", expected: 6n, received: 7n });
  assert.equal(mirror.isLive(), false);
  assert.deepEqual(mirror.book(5), { bids: [], asks: [] }, "a stale book shows nothing");
  mirror.apply(snapshot(9n, 4199n));
  assert.equal(mirror.book(1).bids[0]?.priceCents, 4199);
});

test("books are conflated: fifty changes inside one interval reach a browser as one message", async () => {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const mirror = new Mirror("ACME");
  mirror.apply(snapshot(1n, 4200n));
  const fanout = new Fanout(http, () => new Map([["ACME", mirror]]));
  const port = (http.address() as AddressInfo).port;

  const received: { type: string; live: boolean }[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/live`);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  socket.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
  socket.send(JSON.stringify({ subscribe: ["ACME", "NOPE"] }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 1, "the current book straight away, and nothing for an unknown symbol");
  assert.equal(received[0]?.live, true);

  for (let i = 0; i < 50; i++) fanout.bookChanged("ACME");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const books = received.filter((m) => m.type === "book").length;
  assert.ok(books >= 2 && books <= 3, `${books} book messages`);

  socket.close();
  fanout.close();
  http.close();
});

test("a browser that cannot keep up is disconnected, and nobody else notices", async () => {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const fanout = new Fanout(http, () => new Map());
  // Two stand-in sockets: one whose send queue is already over the limit.
  const sent: string[] = [];
  let slowTerminated = false;
  const fast = { bufferedAmount: 0, send: (m: string) => sent.push(m), terminate() {} };
  const slow = { bufferedAmount: 5_000_000, send() {}, terminate: () => (slowTerminated = true) };
  const subscribers = (fanout as unknown as { subscribers: Map<object, Set<string>> }).subscribers;
  subscribers.set(fast, new Set(["ACME"]));
  subscribers.set(slow, new Set(["ACME"]));

  fanout.trade({ venue: "ALPHA", symbol: "ACME", tsNs: 0n, priceCents: 4200, size: 1, aggressor: "BUY", feedSeq: 1, symbolSeq: 1, tradeId: "1" });
  assert.equal(slowTerminated, true);
  assert.equal(fanout.stats.dropped, 1);
  assert.equal(sent.length, 1, "the other client still got the trade");
  assert.equal(fanout.clients(), 1);
  fanout.close();
  http.close();
});
