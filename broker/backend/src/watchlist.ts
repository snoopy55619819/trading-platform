// An account's watchlist: symbols it keeps an eye on, in order. Plain data access; the
// only rules are that a symbol must be one we list, appears once, and the list has a cap.

import type { Db } from "./db.ts";

export const MAX_WATCHLIST = 50;
/** What a new account starts with, so its first screen is not empty. */
const DEFAULT_SIZE = 5;

export async function watchlist(db: Db, accountId: string): Promise<string[]> {
  const { rows } = await db.query<{ symbol: string }>(
    "SELECT symbol FROM broker.watchlist WHERE account_id = $1 ORDER BY position, added_at",
    [accountId],
  );
  return rows.map((r) => r.symbol);
}

export type WatchResult = { ok: true; symbols: string[] } | { ok: false; reason: "UNKNOWN_SYMBOL" | "WATCHLIST_FULL" };

/** Adds a symbol at the end. Adding one already there changes nothing. */
export async function watch(db: Db, accountId: string, symbol: string): Promise<WatchResult> {
  const listed = await db.query("SELECT 1 FROM broker.securities WHERE ticker = $1", [symbol]);
  if (listed.rowCount === 0) return { ok: false, reason: "UNKNOWN_SYMBOL" };
  const current = await watchlist(db, accountId);
  if (current.includes(symbol)) return { ok: true, symbols: current };
  if (current.length >= MAX_WATCHLIST) return { ok: false, reason: "WATCHLIST_FULL" };
  await db.query(
    `INSERT INTO broker.watchlist (account_id, symbol, position)
     VALUES ($1, $2, (SELECT coalesce(max(position), 0) + 1 FROM broker.watchlist WHERE account_id = $1))
     ON CONFLICT DO NOTHING`,
    [accountId, symbol],
  );
  return { ok: true, symbols: await watchlist(db, accountId) };
}

/** Removes a symbol. Removing one that is not there changes nothing. */
export async function unwatch(db: Db, accountId: string, symbol: string): Promise<string[]> {
  await db.query("DELETE FROM broker.watchlist WHERE account_id = $1 AND symbol = $2", [accountId, symbol]);
  return watchlist(db, accountId);
}

/** Gives a new account the first few active symbols. */
export async function seedWatchlist(db: Db, accountId: string): Promise<void> {
  await db.query(
    `INSERT INTO broker.watchlist (account_id, symbol, position)
     SELECT $1, ticker, row_number() OVER (ORDER BY ticker)
     FROM broker.securities WHERE status = 'ACTIVE' ORDER BY ticker LIMIT $2`,
    [accountId, DEFAULT_SIZE],
  );
}
