// Trades by day (ADR 0014) against the real database, each test in a rolled-back
// transaction. Test trades are on days in January 2026, before anything real, so the job
// never touches the running service's days.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";

import { type Db, createPool } from "../src/db.ts";
import { COLUMNS, ensurePartitions, maintainTrades, partitionDays } from "../src/store/archive.ts";
import { insertTicks } from "../src/store/ticks.ts";

const pool = createPool();
after(() => pool.end());

async function rolledBack(work: (db: Db, dir: string) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  const dir = mkdtempSync(join(tmpdir(), "md-archive-"));
  try {
    await client.query("BEGIN");
    await ensurePartitions(client, "2026-01-01", "2026-01-03");
    await work(client, dir);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    rmSync(dir, { recursive: true, force: true });
  }
}

let seq = 2_000_000_000;
async function trades(db: Db, at: string, count: number): Promise<void> {
  const base = BigInt(Date.parse(at)) * 1_000_000n;
  await insertTicks(
    db,
    Array.from({ length: count }, (_, i) => {
      seq += 1;
      return {
        venue: "TEST", symbol: i % 2 ? "T_A" : "T_B", tsNs: base + BigInt(i) * 1_000_123n,
        priceCents: 4200 + i, size: 10 + i, aggressor: i % 3 ? "BUY" : "SELL", feedSeq: seq, symbolSeq: seq, tradeId: `t,"${seq}"`,
      } as const;
    }),
  );
}

const at = (iso: string) => Date.parse(iso);

test("a finished day is written out once it has settled, and dropped once old enough", () =>
  rolledBack(async (db, dir) => {
    await trades(db, "2026-01-01T12:00:00Z", 5);
    await trades(db, "2026-01-02T23:59:59Z", 3);
    await trades(db, "2026-01-03T00:05:00Z", 2);

    // Just after midnight: 1 January is done; 2 January ended too recently.
    let done = await maintainTrades(db, dir, at("2026-01-03T00:10:00Z"), 1);
    assert.deepEqual(done.archived, [{ day: "2026-01-01", trades: 5 }]);
    // Old enough to go, but only just written: it gets a night to reach S3 first.
    assert.deepEqual(done.dropped, []);

    // Later that night: 2 January is written; nothing is written twice.
    done = await maintainTrades(db, dir, at("2026-01-03T01:00:00Z"), 1);
    assert.deepEqual(done.archived, [{ day: "2026-01-02", trades: 3 }]);
    assert.deepEqual(done.dropped, []);
    assert.deepEqual(readdirSync(dir).sort(), ["ticks-2026-01-01.csv.gz", "ticks-2026-01-02.csv.gz"]);

    // A day on, 4 January: 3 January is written. 1 and 2 January are older than yesterday
    // and were written a day or more ago, so they go; 3 January (yesterday) stays.
    done = await maintainTrades(db, dir, at("2026-01-04T01:00:00Z"), 1);
    assert.deepEqual(done.archived, [{ day: "2026-01-03", trades: 2 }]);
    assert.deepEqual(done.dropped, ["2026-01-01", "2026-01-02"]);
    const days = await partitionDays(db);
    assert.ok(!days.includes("2026-01-02") && days.includes("2026-01-03"));
    assert.ok(days.includes("2026-01-07"), "partitions are made three days ahead");
  }));

test("the file has a header and every trade exactly as stored", () =>
  rolledBack(async (db, dir) => {
    await trades(db, "2026-01-01T09:30:00.123456Z", 4);
    await maintainTrades(db, dir, at("2026-01-02T01:00:00Z"), 1);

    const lines = gunzipSync(readFileSync(join(dir, "ticks-2026-01-01.csv.gz"))).toString().trimEnd().split("\n");
    assert.equal(lines[0], COLUMNS.join(","));
    assert.equal(lines.length, 5);
    const { rows } = await db.query<{ line: string }>(
      `SELECT concat_ws(',', tick_id, venue, symbol,
                to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), ts_ns, event_type,
                price_cents, size, aggressor, feed_seq, symbol_seq, '"' || replace(trade_id, '"', '""') || '"') AS line
         FROM market_data.ticks WHERE ts >= '2026-01-01' AND ts < '2026-01-02' ORDER BY tick_id`,
    );
    assert.deepEqual(lines.slice(1), rows.map((r) => r.line));
    // The time written reads back as the same instant.
    const first = lines[1]!.split(",")[3]!;
    const { rows: same } = await db.query<{ same: boolean }>(
      "SELECT $1::timestamptz = (SELECT ts FROM market_data.ticks WHERE ts >= '2026-01-01' AND ts < '2026-01-02' ORDER BY tick_id LIMIT 1) AS same",
      [first],
    );
    assert.equal(same[0]!.same, true);
  }));
