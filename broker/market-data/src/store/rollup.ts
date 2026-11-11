// Candles. 1-minute bars are computed from ticks; 5-minute, 1-hour and 1-day bars from the
// 1-minute ones. Each run recomputes, from scratch, every bucket that gained a tick since
// the last run, and replaces the stored bar. So running twice changes nothing, a tick that
// arrives late lands in the right bar, and a restart cannot double anything.
//
// Assumes one writer of ticks (this process) running flushes and rollups one at a time,
// which is how main.ts runs them: then every tick id below the watermark is committed.

import type { Db } from "../db.ts";

export const INTERVALS = ["1m", "5m", "1h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_SECONDS: Record<Interval, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86_400 };

const STRIDE: Record<Interval, string> = { "1m": "1 minute", "5m": "5 minutes", "1h": "1 hour", "1d": "1 day" };

/**
 * Where buckets start. Minutes and hours align to UTC; days align to the venue's business
 * day, which rolls at `dayRollUtc` (21:00, after the New York close), not at UTC midnight.
 */
export function origins(dayRollUtc: string): Record<Interval, string> {
  const epoch = "2000-01-01T00:00:00Z";
  return { "1m": epoch, "5m": epoch, "1h": epoch, "1d": `2000-01-01T${dayRollUtc}Z` };
}

const UPSERT = `ON CONFLICT (symbol, interval, bucket_ts) DO UPDATE SET
  open_cents = EXCLUDED.open_cents, high_cents = EXCLUDED.high_cents,
  low_cents = EXCLUDED.low_cents, close_cents = EXCLUDED.close_cents,
  volume = EXCLUDED.volume, trade_count = EXCLUDED.trade_count`;

/** Rolls up everything new since the last run. Returns how many ticks it took in. */
export async function rollup(db: Db, dayRollUtc: string): Promise<number> {
  const { rows: state } = await db.query<{ last_tick_id: number }>(
    "SELECT last_tick_id FROM market_data.rollup_state FOR UPDATE",
  );
  const last = state[0]?.last_tick_id ?? 0;
  const { rows: dirty } = await db.query<{ symbol: string; from_ts: Date; max_id: number; ticks: number }>(
    `SELECT symbol, min(ts) AS from_ts, max(tick_id) AS max_id, count(*)::bigint AS ticks
     FROM market_data.ticks WHERE tick_id > $1 GROUP BY symbol`,
    [last],
  );
  if (dirty.length === 0) return 0;
  const origin = origins(dayRollUtc);

  for (const { symbol, from_ts } of dirty) {
    // 1-minute bars from ticks. Open and close are the first and last trade by time, then
    // by feed_seq for trades sequenced in the same instant.
    await db.query(
      `INSERT INTO market_data.bars
         (symbol, interval, bucket_ts, open_cents, high_cents, low_cents, close_cents, volume, trade_count)
       SELECT symbol, '1m', date_bin('1 minute', ts, $3::timestamptz),
              (array_agg(price_cents ORDER BY ts, feed_seq))[1],
              max(price_cents), min(price_cents),
              (array_agg(price_cents ORDER BY ts DESC, feed_seq DESC))[1],
              sum(size), count(*)
       FROM market_data.ticks
       WHERE symbol = $1 AND ts >= date_bin('1 minute', $2::timestamptz, $3::timestamptz)
       GROUP BY symbol, date_bin('1 minute', ts, $3::timestamptz)
       ${UPSERT}`,
      [symbol, from_ts, origin["1m"]],
    );
    // Longer bars from 1-minute ones: the same arithmetic one level up.
    for (const interval of ["5m", "1h", "1d"] as const) {
      await db.query(
        `INSERT INTO market_data.bars
           (symbol, interval, bucket_ts, open_cents, high_cents, low_cents, close_cents, volume, trade_count)
         SELECT symbol, $4, date_bin($5::interval, bucket_ts, $3::timestamptz),
                (array_agg(open_cents ORDER BY bucket_ts))[1],
                max(high_cents), min(low_cents),
                (array_agg(close_cents ORDER BY bucket_ts DESC))[1],
                sum(volume), sum(trade_count)
         FROM market_data.bars
         WHERE symbol = $1 AND interval = '1m'
           AND bucket_ts >= date_bin($5::interval, $2::timestamptz, $3::timestamptz)
         GROUP BY symbol, date_bin($5::interval, bucket_ts, $3::timestamptz)
         ${UPSERT}`,
        [symbol, from_ts, origin[interval], interval, STRIDE[interval]],
      );
    }
  }

  const newest = Math.max(...dirty.map((d) => d.max_id));
  await db.query("UPDATE market_data.rollup_state SET last_tick_id = $1, updated_at = now()", [newest]);
  return dirty.reduce((sum, d) => sum + d.ticks, 0);
}

export interface Bar {
  t: string;
  openCents: number;
  highCents: number;
  lowCents: number;
  closeCents: number;
  volume: number;
  trades: number;
}

export async function bars(db: Db, symbol: string, interval: Interval, from: Date, to: Date): Promise<Bar[]> {
  const { rows } = await db.query<{
    bucket_ts: Date; open_cents: number; high_cents: number; low_cents: number;
    close_cents: number; volume: number; trade_count: number;
  }>(
    `SELECT * FROM market_data.bars
     WHERE symbol = $1 AND interval = $2 AND bucket_ts >= $3 AND bucket_ts < $4
     ORDER BY bucket_ts`,
    [symbol, interval, from, to],
  );
  return rows.map((r) => ({
    t: r.bucket_ts.toISOString(),
    openCents: r.open_cents,
    highCents: r.high_cents,
    lowCents: r.low_cents,
    closeCents: r.close_cents,
    volume: r.volume,
    trades: r.trade_count,
  }));
}
