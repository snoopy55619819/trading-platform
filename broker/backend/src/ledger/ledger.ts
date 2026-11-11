// Posting to the books, and reading balances back out of them.
//
// Every function takes the caller's `Db`, so it runs inside the caller's transaction: at
// milestone 6 the OMS checks buying power and writes an order in one commit, and a fill is
// booked in the same commit that records it. Nothing here opens its own transaction.
//
// The database enforces that entries balance and that history is append-only (see
// migrations/0002_ledger.sql). This code decides which lines to write; it cannot write
// wrong ones that survive a commit.

import type { Db } from "../db.ts";
import { AccountType, type Fill } from "../domain/index.ts";
import { ulid } from "../ids.ts";

export const CASH = "CASH";

/** v1 settles on the trade date. T+1 changes this number, nothing else. */
export const SETTLEMENT_DAYS = 0;

type EntryReference = "FILL" | "DEPOSIT" | "SETTLEMENT";

interface Line {
  account: string;
  asset: string;
  debit: number;
  credit: number;
}

/** Moving `amount` of `asset` from one account to another: debit one, credit the other. */
function transfer(asset: string, debit: string, credit: string, amount: number): Line[] {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`bad amount ${amount}`);
  if (amount === 0) return [];
  return [
    { account: debit, asset, debit: amount, credit: 0 },
    { account: credit, asset, debit: 0, credit: amount },
  ];
}

/** Opens a client's brokerage account. Ledger accounts for it are created as needed. */
export async function openAccount(db: Db, name: string, currency = "USD"): Promise<string> {
  const accountId = ulid();
  await db.query("INSERT INTO broker.accounts (account_id, name, currency) VALUES ($1, $2, $3)", [
    accountId,
    name,
    currency,
  ]);
  return accountId;
}

/** The ledger account for an owner (null for the house), type and asset, created if new. */
export async function ledgerAccount(
  db: Db,
  owner: string | null,
  type: AccountType,
  asset: string,
): Promise<string> {
  const normal = type === AccountType.HOUSE_CASH || type === AccountType.STREET_CONTRA ? "DEBIT" : "CREDIT";
  // Two statements, not one: if another transaction creates the same account concurrently,
  // the INSERT waits for it, and only a new statement sees the row it committed.
  await db.query(
    `INSERT INTO broker.ledger_accounts (ledger_account_id, owner_id, account_type, asset, normal_balance)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ON CONSTRAINT ledger_accounts_unique DO NOTHING`,
    [ulid(), owner, type, asset, normal],
  );
  const { rows } = await db.query<{ ledger_account_id: string }>(
    `SELECT ledger_account_id FROM broker.ledger_accounts
     WHERE owner_id IS NOT DISTINCT FROM $1 AND account_type = $2 AND asset = $3`,
    [owner, type, asset],
  );
  const id = rows[0]?.ledger_account_id;
  if (!id) throw new Error(`ledger account ${type}/${asset} for ${owner ?? "house"} was not created`);
  return id;
}

/**
 * Writes one entry, or nothing if an entry for this reference already exists. Returns the
 * entry id and whether this call wrote it.
 */
async function post(
  db: Db,
  reference: EntryReference,
  referenceId: string,
  description: string,
  lines: Line[],
): Promise<{ entryId: string; posted: boolean }> {
  const inserted = await db.query<{ entry_id: string }>(
    `INSERT INTO broker.journal_entries (entry_id, description, reference_type, reference_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT journal_entries_reference_unique DO NOTHING
     RETURNING entry_id`,
    [ulid(), description, reference, referenceId],
  );
  const entryId = inserted.rows[0]?.entry_id;
  if (!entryId) {
    const existing = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM broker.journal_entries WHERE reference_type = $1 AND reference_id = $2",
      [reference, referenceId],
    );
    return { entryId: existing.rows[0]!.entry_id, posted: false };
  }
  const values: unknown[] = [];
  const rows = lines.map((line, i) => {
    values.push(entryId, line.account, line.asset, line.debit, line.credit);
    const n = i * 5;
    return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5})`;
  });
  await db.query(
    `INSERT INTO broker.journal_lines (entry_id, ledger_account_id, asset, debit, credit)
     VALUES ${rows.join(", ")}`,
    values,
  );
  return { entryId, posted: true };
}

/**
 * Credits a client with cash: an opening balance or a deposit. The broker's bank account
 * goes up by the same amount. `reference` makes it idempotent: a retried deposit with the
 * same reference is booked once.
 */
export async function creditCash(
  db: Db,
  accountId: string,
  amountCents: number,
  reference: string,
): Promise<{ entryId: string; posted: boolean }> {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error(`a deposit must be a positive number of cents, not ${amountCents}`);
  }
  const bank = await ledgerAccount(db, null, AccountType.HOUSE_CASH, CASH);
  const client = await ledgerAccount(db, accountId, AccountType.CLIENT_CASH, CASH);
  return post(db, "DEPOSIT", reference, `deposit for ${accountId}`, transfer(CASH, bank, client, amountCents));
}

/**
 * Books one fill: one entry, three balanced pairs.
 *
 *   cash    the notional moves between the client and the street
 *   fee     the client pays the broker (a rebate runs the other way)
 *   shares  between the street and the client's UNSETTLED holding; the settle job moves
 *           them to SETTLED on the settlement date
 *
 * Idempotent on `fillId`: booking the same fill twice writes nothing the second time. The
 * same id with different details is a bug upstream and throws.
 */
export async function postFill(db: Db, fill: Fill): Promise<{ entryId: string; posted: boolean }> {
  if (!Number.isSafeInteger(fill.qty) || fill.qty <= 0) throw new Error(`bad fill qty ${fill.qty}`);
  if (!Number.isSafeInteger(fill.priceCents) || fill.priceCents <= 0) {
    throw new Error(`bad fill price ${fill.priceCents}`);
  }
  if (fill.notionalCents !== fill.qty * fill.priceCents) {
    throw new Error(`fill ${fill.fillId}: notional ${fill.notionalCents} is not qty x price`);
  }

  const recorded = await db.query(
    `INSERT INTO broker.fills (fill_id, venue, exec_id, order_id, trade_id, account_id, symbol,
        side, qty, price_cents, notional_cents, fee_cents, currency, transact_ts_ns,
        business_date, settlement_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::date,
        $15::date + $16::integer)
     ON CONFLICT (fill_id) DO NOTHING
     RETURNING fill_id`,
    [
      fill.fillId, fill.venue, fill.execId, fill.orderId, fill.tradeId, fill.accountId,
      fill.symbol, fill.side, fill.qty, fill.priceCents, fill.notionalCents, fill.feeCents,
      fill.currency, fill.transactTsNs.toString(), fill.businessDate, SETTLEMENT_DAYS,
    ],
  );
  if (recorded.rowCount === 0) {
    await assertSameFill(db, fill);
  }

  const client = fill.accountId;
  const clientCash = await ledgerAccount(db, client, AccountType.CLIENT_CASH, CASH);
  const unsettled = await ledgerAccount(db, client, AccountType.CLIENT_SECURITIES_UNSETTLED, fill.symbol);
  const streetCash = await ledgerAccount(db, null, AccountType.STREET_CONTRA, CASH);
  const streetShares = await ledgerAccount(db, null, AccountType.STREET_CONTRA, fill.symbol);
  const fees = await ledgerAccount(db, null, AccountType.FEES_REVENUE, CASH);

  // A buy: the client owes the street cash, and the street owes the client shares.
  // A sell is the same with every pair reversed.
  const buy = fill.side === "BUY";
  const lines = [
    ...(buy
      ? transfer(CASH, clientCash, streetCash, fill.notionalCents)
      : transfer(CASH, streetCash, clientCash, fill.notionalCents)),
    ...(fill.feeCents >= 0
      ? transfer(CASH, clientCash, fees, fill.feeCents)
      : transfer(CASH, fees, clientCash, -fill.feeCents)),
    ...(buy
      ? transfer(fill.symbol, streetShares, unsettled, fill.qty)
      : transfer(fill.symbol, unsettled, streetShares, fill.qty)),
  ];
  const what = `${fill.side} ${fill.qty} ${fill.symbol} @ ${fill.priceCents}c`;
  return post(db, "FILL", fill.fillId, what, lines);
}

async function assertSameFill(db: Db, fill: Fill): Promise<void> {
  const { rows } = await db.query<{
    account_id: string; symbol: string; side: string; qty: number; price_cents: number; fee_cents: number;
  }>(
    "SELECT account_id, symbol, side, qty, price_cents, fee_cents FROM broker.fills WHERE fill_id = $1",
    [fill.fillId],
  );
  const existing = rows[0];
  const same =
    existing &&
    existing.account_id === fill.accountId &&
    existing.symbol === fill.symbol &&
    existing.side === fill.side &&
    existing.qty === fill.qty &&
    existing.price_cents === fill.priceCents &&
    existing.fee_cents === fill.feeCents;
  if (!same) throw new Error(`fill ${fill.fillId} was already booked with different details`);
}

/** A client's cash, in cents. */
export async function cashBalance(db: Db, accountId: string): Promise<number> {
  const { rows } = await db.query<{ balance: number }>(
    `SELECT balance FROM broker.account_balances
     WHERE owner_id = $1 AND account_type = 'CLIENT_CASH'`,
    [accountId],
  );
  return rows[0]?.balance ?? 0;
}

export interface Holding {
  symbol: string;
  qtySettled: number;
  qtyUnsettled: number;
}

/** A client's shares per symbol, split by settlement state. Symbols netted to zero are omitted. */
export async function holdings(db: Db, accountId: string): Promise<Holding[]> {
  const { rows } = await db.query<{ symbol: string; settled: number; unsettled: number }>(
    `SELECT asset AS symbol,
            sum(balance) FILTER (WHERE account_type = 'CLIENT_SECURITIES_SETTLED')::bigint AS settled,
            sum(balance) FILTER (WHERE account_type = 'CLIENT_SECURITIES_UNSETTLED')::bigint AS unsettled
     FROM broker.account_balances
     WHERE owner_id = $1 AND account_type LIKE 'CLIENT\\_SECURITIES\\_%'
     GROUP BY asset
     ORDER BY asset`,
    [accountId],
  );
  return rows
    .map((r) => ({ symbol: r.symbol, qtySettled: r.settled ?? 0, qtyUnsettled: r.unsettled ?? 0 }))
    .filter((h) => h.qtySettled !== 0 || h.qtyUnsettled !== 0);
}

export { post as postEntry, transfer };
