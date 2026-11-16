// Trades by day (ADR 0014). `ticks` is partitioned by UTC day; this keeps the partitions
// coming, writes each finished day to a gzipped CSV file, and drops a day's partition once
// it is written and old enough. The server sends the files to S3 (hosting/backup.sh), so
// nothing here needs AWS.
//
// Runs at start (before anything is stored, so today's partition exists) and then hourly.

import { once } from "node:events";
import { createWriteStream, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";

import type { Db } from "../db.ts";

/** Partitions are made this many days ahead, so a trade always has somewhere to go. */
export const DAYS_AHEAD = 3;
/** A finished day is written out only this long after it ends, so late trades are in. */
export const SETTLE_MS = 30 * 60 * 1000;
/** A written day's partition is kept at least this long, so the server has sent its file to
 * S3 (nightly, hosting/backup.sh) before the trades leave Postgres. */
export const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
/** Rows read at a time when writing a day out. */
const BATCH = 50_000;

/** The table's columns, in order: the file's header, and what `COPY` loads back. */
export const COLUMNS = [
  "tick_id", "venue", "symbol", "ts", "ts_ns", "event_type",
  "price_cents", "size", "aggressor", "feed_seq", "symbol_seq", "trade_id",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `YYYY-MM-DD` of a UTC day. */
export const dayOf = (at: Date | number): string => new Date(at).toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
const partition = (day: string): string => `ticks_${day.replaceAll("-", "")}`;

/** Creates any missing partitions for the days `from` to `to`, inclusive. */
export async function ensurePartitions(db: Db, from: string, to: string): Promise<void> {
  for (let day = from; day <= to; day = addDays(day, 1)) {
    await db.query(
      `CREATE TABLE IF NOT EXISTS market_data.${partition(day)} PARTITION OF market_data.ticks
       FOR VALUES FROM ('${day}T00:00:00Z') TO ('${addDays(day, 1)}T00:00:00Z')`,
    );
  }
}

/** The days that have a partition, oldest first. */
export async function partitionDays(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'market_data' AND p.relname = 'ticks'`,
  );
  return rows
    .flatMap(({ name }) => {
      const m = /^ticks_(\d{4})(\d{2})(\d{2})$/.exec(name);
      return m ? [`${m[1]}-${m[2]}-${m[3]}`] : [];
    })
    .sort();
}

/** A CSV field: quoted only when it has to be. */
function csv(value: unknown): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Writes one day's trades to `<dir>/ticks-<day>.csv.gz`: under a temporary name, renamed only
 * when complete, so a file with the final name is always whole. Returns the file and the
 * number of trades in it.
 */
export async function exportDay(db: Db, day: string, dir: string): Promise<{ file: string; trades: number }> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `ticks-${day}.csv.gz`);
  const temporary = `${file}.tmp`;
  const gzip = createGzip();
  const out = createWriteStream(temporary);
  gzip.pipe(out);
  const write = async (text: string) => {
    if (!gzip.write(text)) await once(gzip, "drain");
  };

  await write(`${COLUMNS.join(",")}\n`);
  let after = 0;
  let trades = 0;
  for (;;) {
    // Text straight from Postgres (ts in UTC), so the file loads back exactly.
    const { rows } = await db.query<Record<string, string>>(
      `SELECT ${COLUMNS.map((c) => (c === "ts" ? "to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS ts" : `${c}::text`)).join(", ")}
         FROM market_data.${partition(day)} WHERE tick_id > $1 ORDER BY tick_id LIMIT ${BATCH}`,
      [after],
    );
    if (rows.length === 0) break;
    await write(rows.map((row) => COLUMNS.map((c) => csv(row[c])).join(",")).join("\n") + "\n");
    trades += rows.length;
    after = Number(rows.at(-1)!.tick_id);
  }
  gzip.end();
  await once(out, "finish");
  renameSync(temporary, file);
  return { file, trades };
}

export interface Maintained {
  archived: { day: string; trades: number }[];
  dropped: string[];
}

/**
 * The hourly job: partitions ahead, every finished day written out (once), and partitions
 * dropped once their day is more than `keepDays` days old and was written out at least a
 * day ago. Today and the last `keepDays` days stay in Postgres.
 */
export async function maintainTrades(db: Db, dir: string, now: number, keepDays: number): Promise<Maintained> {
  const today = dayOf(now);
  await ensurePartitions(db, today, addDays(today, DAYS_AHEAD));

  const { rows } = await db.query<{ day: string; at: Date }>(
    "SELECT day::text AS day, archived_at AS at FROM market_data.archived_days",
  );
  const archived = new Map(rows.map((r) => [r.day, r.at.getTime()]));
  const result: Maintained = { archived: [], dropped: [] };

  for (const day of await partitionDays(db)) {
    const ended = Date.parse(`${addDays(day, 1)}T00:00:00Z`);
    if (!archived.has(day) && now >= ended + SETTLE_MS) {
      const { file, trades } = await exportDay(db, day, dir);
      await db.query(
        `INSERT INTO market_data.archived_days (day, file, trades, archived_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (day) DO UPDATE SET file = EXCLUDED.file, trades = EXCLUDED.trades, archived_at = EXCLUDED.archived_at`,
        [day, file, trades, new Date(now)],
      );
      archived.set(day, now);
      result.archived.push({ day, trades });
    }
    const writtenAt = archived.get(day);
    if (writtenAt !== undefined && now - writtenAt >= UPLOAD_GRACE_MS && day < addDays(today, -keepDays)) {
      await db.query(`DROP TABLE market_data.${partition(day)}`);
      result.dropped.push(day);
    }
  }
  return result;
}
