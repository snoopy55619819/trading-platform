// The settle job: moves a fill's shares from UNSETTLED to SETTLED once its settlement date
// arrives. v1 settles on the trade date, so it books everything there is; post-MVP the
// fills carry a later date and the same job simply finds them later.
//
// One entry per fill, referenced by the fill's id, so running the job twice, or two copies
// at once, books each settlement exactly once.

import type { Db } from "../db.ts";
import { AccountType } from "../domain/index.ts";
import { ledgerAccount, postEntry, transfer } from "./ledger.ts";

/**
 * Settles fills due on or before `asOf` (an ISO date). Returns how many were settled.
 * At most `limit` per call, so a backlog is worked through in bounded transactions.
 */
export async function settle(db: Db, asOf: string, limit = 1000): Promise<number> {
  const { rows } = await db.query<{
    fill_id: string; account_id: string; symbol: string; side: string; qty: number;
  }>(
    `SELECT f.fill_id, f.account_id, f.symbol, f.side, f.qty
     FROM broker.fills f
     WHERE f.settlement_date <= $1::date
       AND NOT EXISTS (
         SELECT 1 FROM broker.journal_entries e
         WHERE e.reference_type = 'SETTLEMENT' AND e.reference_id = f.fill_id)
     ORDER BY f.fill_id
     LIMIT $2
     FOR UPDATE OF f SKIP LOCKED`,
    [asOf, limit],
  );
  let settled = 0;
  for (const fill of rows) {
    const unsettled = await ledgerAccount(db, fill.account_id, AccountType.CLIENT_SECURITIES_UNSETTLED, fill.symbol);
    const settledAccount = await ledgerAccount(db, fill.account_id, AccountType.CLIENT_SECURITIES_SETTLED, fill.symbol);
    // Client securities are credit-normal: crediting an account adds shares to it.
    const lines =
      fill.side === "BUY"
        ? transfer(fill.symbol, unsettled, settledAccount, fill.qty)
        : transfer(fill.symbol, settledAccount, unsettled, fill.qty);
    const { posted } = await postEntry(db, "SETTLEMENT", fill.fill_id, `settle ${fill.side} ${fill.qty} ${fill.symbol}`, lines);
    if (posted) settled += 1;
  }
  return settled;
}
