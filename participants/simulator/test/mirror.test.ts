import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { FeedMessageSchema, type FeedMessage } from "../gen/marketdata_pb.js";
import { Mirror } from "../src/feed/mirror.ts";

const snapshot = (symbolSeq: bigint, bid: bigint): FeedMessage =>
  create(FeedMessageSchema, {
    payload: {
      case: "snapshot",
      value: { symbol: "ACME", symbolSeq, bids: [{ priceCents: bid, qty: 100n, orderCount: 1 }] },
    },
  });

const delta = (symbolSeq: bigint, priceCents: bigint, qty: bigint): FeedMessage =>
  create(FeedMessageSchema, {
    payload: { case: "bookDelta", value: { symbol: "ACME", symbolSeq, side: 1, priceCents, qty } },
  });

test("deltas count only after the snapshot, and old ones are ignored", () => {
  const mirror = new Mirror("ACME");
  assert.equal(mirror.apply(delta(1n, 4200n, 100n)).kind, "ignored");
  mirror.apply(snapshot(1n, 4200n));
  assert.equal(mirror.apply(delta(1n, 4200n, 999n)).kind, "ignored");
  assert.equal(mirror.apply(delta(2n, 4201n, 50n)).kind, "applied");
  assert.equal(mirror.bestBid(), 4201);
  mirror.apply(delta(3n, 4201n, 0n));
  assert.equal(mirror.bestBid(), 4200);
});

test("a skipped symbol_seq makes the book stale until the next snapshot", () => {
  const mirror = new Mirror("ACME");
  mirror.apply(snapshot(5n, 4200n));
  assert.deepEqual(mirror.apply(delta(7n, 4201n, 10n)), { kind: "gap", expected: 6n, received: 7n });
  assert.equal(mirror.isLive(), false);
  assert.equal(mirror.bestBid(), undefined, "a stale book shows no prices");
  assert.equal(mirror.apply(delta(8n, 4202n, 10n)).kind, "ignored");
  mirror.apply(snapshot(8n, 4199n));
  assert.equal(mirror.bestBid(), 4199);
});

test("a trade print says which side took liquidity", () => {
  const mirror = new Mirror("ACME");
  mirror.apply(snapshot(1n, 4200n));
  const print = (symbolSeq: bigint, aggressorSide: number): FeedMessage =>
    create(FeedMessageSchema, {
      payload: { case: "tradePrint", value: { symbol: "ACME", symbolSeq, priceCents: 4201n, qty: 30n, aggressorSide } },
    });
  assert.deepEqual(mirror.apply(print(2n, 1)), { kind: "trade", priceCents: 4201, qty: 30, buyerAggressed: true });
  assert.deepEqual(mirror.apply(print(3n, 2)), { kind: "trade", priceCents: 4201, qty: 30, buyerAggressed: false });
});
