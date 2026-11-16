// Live platform stats (ADR 0016): the exchange's VenueStats joined with this service's own
// counters, once a second, with five minutes kept.

import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { FeedMessageSchema, VenueStatsSchema } from "../gen/marketdata_pb.js";
import { Subscriber } from "../src/feed/subscriber.ts";
import { type Counters, HISTORY, Stats } from "../src/stats.ts";

const venue = (transactionsPerSec: number) =>
  create(VenueStatsSchema, { venue: "ALPHA", businessDate: "2026-11-17", transactionsPerSec, tradesPerSec: 6, answerP99Us: 7000, transactionsToday: 123n });
const counters = (n: number): Counters => ({ browsers: 3, feedMessages: 100 * n, liveMessages: 40 * n, tradesStored: 6 * n, gaps: 0 });

test("this service's counters become rates per second; the venue's numbers pass through", () => {
  const stats = new Stats();
  stats.sample(counters(0), 0);
  stats.venueStats(venue(300), 1500);
  const s = stats.sample(counters(2), 2000);
  assert.deepEqual(s.marketData, { browsers: 3, feedMessagesInPerSec: 100, liveMessagesOutPerSec: 40, tradesStoredPerSec: 6, feedGaps: 0 });
  assert.equal(s.venue?.transactionsPerSec, 300);
  assert.equal(s.venue?.transactionsToday, 123);
  assert.equal(s.ts, new Date(2000).toISOString());
});

test("the venue's numbers go stale if it falls silent", () => {
  const stats = new Stats();
  stats.venueStats(venue(300), 0);
  assert.notEqual(stats.sample(counters(1), 2000).venue, null);
  assert.equal(stats.sample(counters(2), 5000).venue, null);
});

test("five minutes are kept, oldest first, trimmed for trend lines", () => {
  const stats = new Stats();
  for (let i = 0; i < HISTORY + 20; i++) {
    stats.venueStats(venue(i), i * 1000);
    stats.sample(counters(i), i * 1000);
  }
  const history = stats.history();
  assert.equal(history.length, HISTORY);
  assert.equal(history[0]!.transactionsPerSec, 20);
  assert.equal(history.at(-1)!.transactionsPerSec, HISTORY + 19);
  assert.deepEqual(Object.keys(history[0]!), ["ts", "transactionsPerSec", "tradesPerSec", "answerP99Us", "liveMessagesOutPerSec"]);
});

test("the feed subscriber hands the venue's stats over, and no book sees them", () => {
  const seen: number[] = [];
  let books = 0;
  const subscriber = new Subscriber("ws://unused", ["ACME"], {
    onTrade: () => {},
    onBook: () => (books += 1),
    onVenueStats: (stats) => seen.push(stats.transactionsPerSec),
  });
  subscriber.handle(undefined, create(FeedMessageSchema, { payload: { case: "venueStats", value: venue(298) } }));
  assert.deepEqual(seen, [298]);
  assert.equal(books, 0);
});
