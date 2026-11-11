// Writes trade prints to `ticks`, in small batches. A print already stored (the same
// venue, feed_seq and ts_ns) is skipped, so writing one twice is harmless.

import type { TradePrint } from "../../gen/marketdata_pb.js";
import type { Db } from "../db.ts";

export interface Tick {
  venue: string;
  symbol: string;
  tsNs: bigint;
  priceCents: number;
  size: number;
  aggressor: "BUY" | "SELL";
  feedSeq: number;
  symbolSeq: number;
  tradeId: string;
}

export function tickFrom(trade: TradePrint): Tick {
  return {
    venue: trade.venue,
    symbol: trade.symbol,
    tsNs: trade.tsNs,
    priceCents: Number(trade.priceCents),
    size: Number(trade.qty),
    aggressor: trade.aggressorSide === 1 ? "BUY" : "SELL",
    feedSeq: Number(trade.feedSeq),
    symbolSeq: Number(trade.symbolSeq),
    tradeId: trade.tradeId,
  };
}

/** Inserts ticks; returns how many were new. */
export async function insertTicks(db: Db, ticks: Tick[]): Promise<number> {
  if (ticks.length === 0) return 0;
  const values: unknown[] = [];
  const rows = ticks.map((t, i) => {
    values.push(t.venue, t.symbol, t.tsNs.toString(), t.priceCents, t.size, t.aggressor, t.feedSeq, t.symbolSeq, t.tradeId);
    const n = i * 9;
    // ts is derived from ts_ns in the database, so the two can never disagree.
    return `($${n + 1}, $${n + 2}, to_timestamp($${n + 3}::numeric / 1e9), $${n + 3}::bigint, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, $${n + 9})`;
  });
  const result = await db.query(
    `INSERT INTO market_data.ticks (venue, symbol, ts, ts_ns, price_cents, size, aggressor, feed_seq, symbol_seq, trade_id)
     VALUES ${rows.join(", ")}
     ON CONFLICT ON CONSTRAINT ticks_once DO NOTHING`,
    values,
  );
  return result.rowCount ?? 0;
}

/** A stored trade, as the web client's time and sales shows it. Same shape as the live feed's. */
export interface RecentTrade {
  priceCents: number;
  qty: number;
  aggressor: "BUY" | "SELL";
  ts: string;
  tradeId: string;
}

/**
 * The latest `limit` trades for a symbol, newest first. Seeds time and sales: the live
 * feed only sends trades from the moment a browser subscribes. Ticks are written every
 * FLUSH_EVERY_MS, so the very newest may not be here yet; the live feed covers those.
 */
export async function recentTrades(db: Db, symbol: string, limit: number): Promise<RecentTrade[]> {
  const { rows } = await db.query<{ price_cents: string; size: string; aggressor: "BUY" | "SELL"; ts_ns: string; trade_id: string }>(
    `SELECT price_cents, size, aggressor, ts_ns::text AS ts_ns, trade_id FROM market_data.ticks
      WHERE symbol = $1 ORDER BY ts DESC, ts_ns DESC, tick_id DESC LIMIT $2`,
    [symbol, limit],
  );
  return rows.map((r) => ({
    priceCents: Number(r.price_cents),
    qty: Number(r.size),
    aggressor: r.aggressor,
    ts: new Date(Number(BigInt(r.ts_ns) / 1_000_000n)).toISOString(),
    tradeId: r.trade_id,
  }));
}
