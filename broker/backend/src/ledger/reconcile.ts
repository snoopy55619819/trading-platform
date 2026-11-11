// Reconciliation: proves the books are true, by checking them against themselves and
// against the fills they were posted from. Each run is recorded, pass or fail.
//
//   ledger_balanced          per asset, total debits equal total credits
//   entries_balanced         no single entry is out of balance (the database prevents it;
//                            this proves it)
//   positions_match_fills    every client's shares, summed from journal lines, equal the
//                            signed sum of their fills, computed separately
//   cash_matches_fills       every client's cash, less deposits, equals what their fills
//                            paid and received
//   fees_match_fills         fee revenue equals the fees on the fills
//   settlement_not_overdue   no fill due before today is still unsettled

import type { Db } from "../db.ts";
import { ulid } from "../ids.ts";

export interface Discrepancy {
  check: string;
  detail: Record<string, unknown>;
}

export interface Reconciliation {
  runId: string;
  passed: boolean;
  discrepancies: Discrepancy[];
}

const CHECKS: Record<string, string> = {
  ledger_balanced: `
    SELECT asset, sum(debit)::bigint AS debits, sum(credit)::bigint AS credits
    FROM broker.journal_lines GROUP BY asset HAVING sum(debit) <> sum(credit)`,

  entries_balanced: `
    SELECT entry_id, asset, sum(debit)::bigint AS debits, sum(credit)::bigint AS credits
    FROM broker.journal_lines GROUP BY entry_id, asset HAVING sum(debit) <> sum(credit)
    LIMIT 50`,

  positions_match_fills: `
    WITH ledger AS (
      SELECT owner_id AS account_id, asset AS symbol, sum(balance)::bigint AS qty
      FROM broker.account_balances
      WHERE account_type LIKE 'CLIENT\\_SECURITIES\\_%'
      GROUP BY owner_id, asset),
    tally AS (
      SELECT account_id, symbol,
             sum(CASE side WHEN 'BUY' THEN qty ELSE -qty END)::bigint AS qty
      FROM broker.fills GROUP BY account_id, symbol)
    SELECT account_id, symbol, coalesce(l.qty, 0) AS ledger, coalesce(t.qty, 0) AS fills
    FROM ledger l FULL JOIN tally t USING (account_id, symbol)
    WHERE coalesce(l.qty, 0) <> coalesce(t.qty, 0)
    LIMIT 50`,

  cash_matches_fills: `
    WITH ledger AS (
      SELECT owner_id AS account_id, balance FROM broker.account_balances
      WHERE account_type = 'CLIENT_CASH'),
    deposits AS (
      SELECT a.owner_id AS account_id, sum(l.credit - l.debit)::bigint AS amount
      FROM broker.journal_lines l
      JOIN broker.journal_entries e USING (entry_id)
      JOIN broker.ledger_accounts a USING (ledger_account_id)
      WHERE e.reference_type = 'DEPOSIT' AND a.account_type = 'CLIENT_CASH'
      GROUP BY a.owner_id),
    tally AS (
      SELECT account_id,
             sum(CASE side WHEN 'BUY' THEN -notional_cents ELSE notional_cents END - fee_cents)::bigint AS amount
      FROM broker.fills GROUP BY account_id)
    SELECT account_id, coalesce(l.balance, 0) - coalesce(d.amount, 0) AS ledger,
           coalesce(t.amount, 0) AS fills
    FROM ledger l FULL JOIN deposits d USING (account_id) FULL JOIN tally t USING (account_id)
    WHERE coalesce(l.balance, 0) - coalesce(d.amount, 0) <> coalesce(t.amount, 0)
    LIMIT 50`,

  fees_match_fills: `
    SELECT (SELECT coalesce(sum(balance), 0)::bigint FROM broker.account_balances
            WHERE account_type = 'FEES_REVENUE') AS ledger,
           (SELECT coalesce(sum(fee_cents), 0)::bigint FROM broker.fills) AS fills
    WHERE (SELECT coalesce(sum(balance), 0) FROM broker.account_balances
           WHERE account_type = 'FEES_REVENUE')
       <> (SELECT coalesce(sum(fee_cents), 0) FROM broker.fills)`,

  settlement_not_overdue: `
    SELECT f.fill_id, f.settlement_date::text
    FROM broker.fills f
    WHERE f.settlement_date < current_date
      AND NOT EXISTS (SELECT 1 FROM broker.journal_entries e
                      WHERE e.reference_type = 'SETTLEMENT' AND e.reference_id = f.fill_id)
    LIMIT 50`,
};

export async function reconcile(db: Db): Promise<Reconciliation> {
  const discrepancies: Discrepancy[] = [];
  for (const [check, sql] of Object.entries(CHECKS)) {
    const { rows } = await db.query(sql);
    for (const detail of rows) discrepancies.push({ check, detail });
  }
  const runId = ulid();
  const passed = discrepancies.length === 0;
  await db.query(
    "INSERT INTO broker.reconciliation_runs (run_id, checks_passed, discrepancies) VALUES ($1, $2, $3)",
    [runId, passed, JSON.stringify(discrepancies)],
  );
  return { runId, passed, discrepancies };
}
