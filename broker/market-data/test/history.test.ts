// History against the real database, each test in a rolled-back transaction. Test ticks use
// their own symbols so they never mix with anything the running service has stored.
//
// test/fixtures/alpha-feed-90s.b64 is 90 seconds of Alpha Exchange's real feed (ACME and
// GRID, with the simulator trading), recorded as raw frames, one base64 line each.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { fromBinary } from "@bufbuild/protobuf";

import { FeedMessageSchema, type TradePrint } from "../gen/marketdata_pb.js";
import { type Db, createPool } from "../src/db.ts";
import { Subscriber } from "../src/feed/subscriber.ts";
import { type Bar, bars, rollup } from "../src/store/rollup.ts";
import { type Tick, insertTicks, recentTrades, tickFrom } from "../src/store/ticks.ts";

const pool = createPool();
after(() => pool.end());
const ROLL = "21:00:00";

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

const ns = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;
let seq = 1_000_000_000;
function tick(symbol: string, at: string, priceCents: number, size: number): Tick {
  seq += 1;
  return { venue: "TEST", symbol, tsNs: ns(at), priceCents, size, aggressor: "BUY", feedSeq: seq, symbolSeq: seq, tradeId: `t${seq}` };
}

const range = (from: string, to: string) => [new Date(from), new Date(to)] as const;
const ohlcv = (b: Bar) => [b.t, b.openCents, b.highCents, b.lowCents, b.closeCents, b.volume, b.trades];

test("hand-computed candles, across minute, five-minute and business-day boundaries", () =>
  rolledBack(async (db) => {
    await insertTicks(db, [
      tick("T_HAND", "2026-11-11T20:58:10Z", 4210, 100), // minute 20:58
      tick("T_HAND", "2026-11-11T20:58:40Z", 4230, 50),
      tick("T_HAND", "2026-11-11T20:58:50Z", 4200, 25),
      tick("T_HAND", "2026-11-11T20:59:30Z", 4220, 10), // minute 20:59
      tick("T_HAND", "2026-11-11T21:00:05Z", 4250, 5), //  21:00: a new business day
    ]);
    await rollup(db, ROLL);

    const minutes = await bars(db, "T_HAND", "1m", ...range("2026-11-11T20:00Z", "2026-11-11T22:00Z"));
    assert.deepEqual(minutes.map(ohlcv), [
      ["2026-11-11T20:58:00.000Z", 4210, 4230, 4200, 4200, 175, 3],
      ["2026-11-11T20:59:00.000Z", 4220, 4220, 4220, 4220, 10, 1],
      ["2026-11-11T21:00:00.000Z", 4250, 4250, 4250, 4250, 5, 1],
    ]);
    const fives = await bars(db, "T_HAND", "5m", ...range("2026-11-11T20:00Z", "2026-11-11T22:00Z"));
    assert.deepEqual(fives.map(ohlcv), [
      ["2026-11-11T20:55:00.000Z", 4210, 4230, 4200, 4220, 185, 4],
      ["2026-11-11T21:00:00.000Z", 4250, 4250, 4250, 4250, 5, 1],
    ]);
    // Days roll at 21:00 UTC: the first four trades belong to the day that began at 21:00
    // on the 10th, the last to the day that began at 21:00 on the 11th.
    const days = await bars(db, "T_HAND", "1d", ...range("2026-11-09T00:00Z", "2026-11-13T00:00Z"));
    assert.deepEqual(days.map(ohlcv), [
      ["2026-11-10T21:00:00.000Z", 4210, 4230, 4200, 4220, 185, 4],
      ["2026-11-11T21:00:00.000Z", 4250, 4250, 4250, 4250, 5, 1],
    ]);
  }));

test("a late tick lands in the right bar, and repeating anything changes nothing", () =>
  rolledBack(async (db) => {
    const first = [tick("T_LATE", "2026-11-11T10:00:10Z", 1000, 10), tick("T_LATE", "2026-11-11T10:00:50Z", 1010, 10)];
    await insertTicks(db, first);
    await rollup(db, ROLL);
    // Arrives after the rollup ran, for a minute already rolled up: a new low.
    await insertTicks(db, [tick("T_LATE", "2026-11-11T10:00:30Z", 990, 5)]);
    await rollup(db, ROLL);
    const window = range("2026-11-11T09:00Z", "2026-11-11T11:00Z");
    const once = await bars(db, "T_LATE", "1m", ...window);
    assert.deepEqual(once.map(ohlcv), [["2026-11-11T10:00:00.000Z", 1000, 1010, 990, 1010, 25, 3]]);

    assert.equal(await insertTicks(db, first), 0, "the same ticks again are not stored again");
    await rollup(db, ROLL);
    await rollup(db, ROLL);
    assert.deepEqual(await bars(db, "T_LATE", "1m", ...window), once);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM market_data.bars WHERE symbol = 'T_LATE'");
    assert.equal(rows[0]?.n, 4, "one bar per interval, never two");
  }));

test("recent trades: the latest few for one symbol, newest first", () =>
  rolledBack(async (db) => {
    await insertTicks(db, [
      tick("T_RECENT", "2026-11-11T10:00:01Z", 1000, 10),
      tick("T_RECENT", "2026-11-11T10:00:03Z", 1020, 30),
      tick("T_OTHER", "2026-11-11T10:00:04Z", 5000, 1),
      tick("T_RECENT", "2026-11-11T10:00:02Z", 1010, 20), // stored late, sorted by time
    ]);
    const trades = await recentTrades(db, "T_RECENT", 2);
    assert.deepEqual(
      trades.map((t) => [t.ts, t.priceCents, t.qty, t.aggressor]),
      [
        ["2026-11-11T10:00:03.000Z", 1020, 30, "BUY"],
        ["2026-11-11T10:00:02.000Z", 1010, 20, "BUY"],
      ],
    );
  }));

test("a recorded feed, replayed, gives the same candles as an independent tally", () =>
  rolledBack(async (db) => {
    const frames = readFileSync(new URL("fixtures/alpha-feed-90s.b64", import.meta.url), "utf8").trim().split("\n");
    const trades: TradePrint[] = [];
    let books = 0;
    const subscriber = new Subscriber("ws://unused", ["ACME", "GRID"], {
      onTrade: (trade) => trades.push(trade),
      onBook: () => (books += 1),
    });
    for (const frame of frames) subscriber.handle(undefined, fromBinary(FeedMessageSchema, Buffer.from(frame, "base64")));
    assert.equal(subscriber.stats.gaps, 0, "the recording has no gaps");
    assert.ok(trades.length >= 10 && books > 100, `${trades.length} trades, ${books} book updates`);

    // Into the database under a test venue and symbols, rolled up, read back. (Under its
    // real venue it would be skipped: these are the very trades the live service stored
    // while this was being recorded, and the same trade is never stored twice.)
    const ticks = trades.map(tickFrom).map((t) => ({ ...t, venue: "TEST", symbol: `T_${t.symbol}` }));
    await insertTicks(db, ticks);
    await rollup(db, ROLL);

    // The same candles computed in plain TypeScript, straight from the trades.
    for (const symbol of ["T_ACME", "T_GRID"]) {
      const expected = new Map<number, number[]>();
      for (const t of ticks.filter((x) => x.symbol === symbol).sort((a, b) => Number(a.tsNs - b.tsNs) || a.feedSeq - b.feedSeq)) {
        const minute = Number(t.tsNs / 60_000_000_000n) * 60_000;
        const bar = expected.get(minute);
        if (!bar) expected.set(minute, [t.priceCents, t.priceCents, t.priceCents, t.priceCents, t.size, 1]);
        else {
          bar[1] = Math.max(bar[1]!, t.priceCents);
          bar[2] = Math.min(bar[2]!, t.priceCents);
          bar[3] = t.priceCents;
          bar[4]! += t.size;
          bar[5]! += 1;
        }
      }
      const stored = await bars(db, symbol, "1m", new Date(0), new Date(Date.now() + 86_400_000));
      assert.deepEqual(
        stored.map((b) => [Date.parse(b.t), b.openCents, b.highCents, b.lowCents, b.closeCents, b.volume, b.trades]),
        [...expected].sort((a, b) => a[0] - b[0]).map(([minute, bar]) => [minute, ...bar]),
        symbol,
      );
    }
  }));
