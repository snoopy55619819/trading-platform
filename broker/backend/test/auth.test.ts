// Sign-up against the real database. Every test runs inside a transaction that is rolled
// back, so nothing is left behind. Needs the broker database migrated and seeded:
//   pnpm db:up && pnpm backend db:migrate && pnpm backend db:seed   (from the repo root)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { OPENING_DEPOSIT_CENTS, signUp } from "../src/api/auth.ts";
import { type Db, createPool } from "../src/db.ts";
import { ulid } from "../src/ids.ts";
import { cashBalance, holdings, reconcile } from "../src/ledger/index.ts";

const pool = createPool();
after(() => pool.end());

/** Runs `work` in a transaction that is always rolled back. */
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

test("a new account starts with $10,000.00 cash, booked as a deposit", () =>
  rolledBack(async (db) => {
    assert.equal(OPENING_DEPOSIT_CENTS, 1_000_000);
    const created = await signUp(db, `${ulid()}@example.com`, "correct horse", "Ada");
    assert.ok(created);
    const { accountId } = created;

    assert.equal(await cashBalance(db, accountId), 1_000_000);
    assert.deepEqual(await holdings(db, accountId), []);

    const { rows } = await db.query<{ reference_id: string; type: string; debit: number; credit: number }>(
      `SELECT e.reference_id, a.account_type AS type, l.debit, l.credit
       FROM broker.journal_entries e
       JOIN broker.journal_lines l USING (entry_id)
       JOIN broker.ledger_accounts a USING (ledger_account_id)
       WHERE e.reference_type = 'DEPOSIT' AND e.entry_id IN (
         SELECT l2.entry_id FROM broker.journal_lines l2
         JOIN broker.ledger_accounts a2 USING (ledger_account_id) WHERE a2.owner_id = $1)
       ORDER BY l.line_id`,
      [accountId],
    );
    assert.deepEqual(
      rows.map((r) => `${r.reference_id} ${r.debit ? "Dr" : "Cr"} ${r.type} ${r.debit || r.credit}`),
      [`opening:${accountId} Dr HOUSE_CASH 1000000`, `opening:${accountId} Cr CLIENT_CASH 1000000`],
    );

    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    assert.deepEqual((await reconcile(db)).discrepancies, []);
  }));

test("a taken email opens no second account and posts no deposit", () =>
  rolledBack(async (db) => {
    const email = `${ulid()}@example.com`;
    assert.ok(await signUp(db, email, "correct horse", "Ada"));
    const entries = async () =>
      (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM broker.journal_entries")).rows[0]!.n;
    const before = await entries();
    assert.equal(await signUp(db, email, "another one", "Ada again"), undefined);
    assert.equal(await entries(), before);
  }));
