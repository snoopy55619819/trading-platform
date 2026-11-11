// The ledger against the real database. Every test runs inside a transaction that is rolled
// back, so nothing is left behind. Needs the broker database migrated and seeded:
//   pnpm db:up && pnpm backend db:migrate && pnpm backend db:seed   (from the repo root)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { type Db, createPool } from "../src/db.ts";
import type { Fill, Side } from "../src/domain/index.ts";
import { ulid } from "../src/ids.ts";
import {
  cashBalance, creditCash, holdings, ledgerAccount, openAccount, postFill, reconcile, settle,
} from "../src/ledger/index.ts";

const pool = createPool();
after(() => pool.end());

const TODAY = new Date().toISOString().slice(0, 10);

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

/** Forces the deferred balance checks to run now, as COMMIT would. */
const checkNow = (db: Db) => db.query("SET CONSTRAINTS ALL IMMEDIATE");

function fill(accountId: string, side: Side, qty: number, priceCents: number, feeCents: number, symbol = "ACME"): Fill {
  return {
    fillId: ulid(), execId: ulid(), tradeId: ulid(), orderId: ulid(),
    accountId, venue: "ALPHA", symbol, side, qty, priceCents,
    notionalCents: qty * priceCents, feeCents, currency: "USD",
    transactTsNs: BigInt(Date.now()) * 1_000_000n, businessDate: TODAY,
  };
}

async function linesOf(db: Db, entryId: string) {
  const { rows } = await db.query<{ type: string; asset: string; debit: number; credit: number }>(
    `SELECT a.account_type AS type, l.asset, l.debit, l.credit
     FROM broker.journal_lines l JOIN broker.ledger_accounts a USING (ledger_account_id)
     WHERE l.entry_id = $1 ORDER BY l.line_id`,
    [entryId],
  );
  return rows.map((r) => `${r.debit ? "Dr" : "Cr"} ${r.type} ${r.asset} ${r.debit || r.credit}`);
}

test("a buy books one entry: cash, fee and shares, each a balanced pair", () =>
  rolledBack(async (db) => {
    const client = await openAccount(db, "Ada");
    const { entryId } = await postFill(db, fill(client, "BUY", 100, 4210, 126));
    assert.deepEqual(await linesOf(db, entryId), [
      "Dr CLIENT_CASH CASH 421000",
      "Cr STREET_CONTRA CASH 421000",
      "Dr CLIENT_CASH CASH 126",
      "Cr FEES_REVENUE CASH 126",
      "Dr STREET_CONTRA ACME 100",
      "Cr CLIENT_SECURITIES_UNSETTLED ACME 100",
    ]);
    await checkNow(db);
  }));

test("balances are derived: deposit, buy, sell with a rebate", () =>
  rolledBack(async (db) => {
    const client = await openAccount(db, "Ada");
    await creditCash(db, client, 1_000_000, ulid());
    await postFill(db, fill(client, "BUY", 100, 4210, 126));
    await postFill(db, fill(client, "SELL", 40, 4300, -34)); // a maker rebate
    // 1,000,000 - 421,000 - 126 + 172,000 + 34
    assert.equal(await cashBalance(db, client), 750_908);
    assert.deepEqual(await holdings(db, client), [{ symbol: "ACME", qtySettled: 0, qtyUnsettled: 60 }]);
    await checkNow(db);
  }));

test("posting a fill is idempotent, and a reused id with different details is refused", () =>
  rolledBack(async (db) => {
    const client = await openAccount(db, "Ada");
    const once = fill(client, "BUY", 10, 4210, 13);
    const first = await postFill(db, once);
    const again = await postFill(db, once);
    assert.equal(first.posted, true);
    assert.deepEqual(again, { entryId: first.entryId, posted: false });
    assert.equal((await holdings(db, client))[0]?.qtyUnsettled, 10);
    await assert.rejects(postFill(db, { ...once, qty: 11, notionalCents: 11 * 4210 }), /different details/);
  }));

test("the settle job moves shares to SETTLED once, and only when due", () =>
  rolledBack(async (db) => {
    const client = await openAccount(db, "Ada");
    await postFill(db, fill(client, "BUY", 100, 4210, 0));
    await postFill(db, fill(client, "SELL", 30, 4220, 0));
    assert.equal(await settle(db, "2000-01-01"), 0, "nothing is due before the trade date");
    assert.ok((await settle(db, TODAY)) >= 2);
    assert.deepEqual(await holdings(db, client), [{ symbol: "ACME", qtySettled: 70, qtyUnsettled: 0 }]);
    const { rows } = await db.query(
      "SELECT 1 FROM broker.fills f WHERE account_id = $1 AND NOT EXISTS (SELECT 1 FROM broker.journal_entries e WHERE e.reference_type = 'SETTLEMENT' AND e.reference_id = f.fill_id)",
      [client],
    );
    assert.equal(rows.length, 0);
    assert.equal(await settle(db, TODAY), 0, "a second run finds nothing to do");
    await checkNow(db);
  }));

// ---- the database's own guarantees, tested by going around the ledger code ----

async function rawEntry(db: Db): Promise<string> {
  const entryId = ulid();
  await db.query(
    "INSERT INTO broker.journal_entries (entry_id, description, reference_type, reference_id) VALUES ($1, 'test', 'DEPOSIT', $1)",
    [entryId],
  );
  return entryId;
}

test("the database refuses an entry that does not balance", () =>
  rolledBack(async (db) => {
    const client = await openAccount(db, "Ada");
    const bank = await ledgerAccount(db, null, "HOUSE_CASH", "CASH");
    const cash = await ledgerAccount(db, client, "CLIENT_CASH", "CASH");
    const entryId = await rawEntry(db);
    await db.query(
      `INSERT INTO broker.journal_lines (entry_id, ledger_account_id, asset, debit, credit)
       VALUES ($1, $2, 'CASH', 100, 0), ($1, $3, 'CASH', 0, 99)`,
      [entryId, bank, cash],
    );
    await assert.rejects(checkNow(db), /does not balance in CASH: debits 100, credits 99/);
  }));

test("the database refuses an entry with no lines", () =>
  rolledBack(async (db) => {
    await rawEntry(db);
    await assert.rejects(checkNow(db), /has no lines/);
  }));

test("the database refuses shares in a cash account", () =>
  rolledBack(async (db) => {
    const client = await openAccount(db, "Ada");
    const cash = await ledgerAccount(db, client, "CLIENT_CASH", "CASH");
    const entryId = await rawEntry(db);
    await assert.rejects(
      db.query(
        "INSERT INTO broker.journal_lines (entry_id, ledger_account_id, asset, debit, credit) VALUES ($1, $2, 'ACME', 0, 100)",
        [entryId, cash],
      ),
      /journal_lines_account_asset/,
    );
  }));

test("history cannot be edited or deleted", () =>
  rolledBack(async (db) => {
    const client = await openAccount(db, "Ada");
    const { entryId } = await creditCash(db, client, 500, ulid());
    await db.query("SAVEPOINT s");
    await assert.rejects(db.query("UPDATE broker.journal_lines SET credit = 5000 WHERE entry_id = $1 AND credit > 0", [entryId]), /append-only/);
    await db.query("ROLLBACK TO SAVEPOINT s");
    await assert.rejects(db.query("DELETE FROM broker.journal_entries WHERE entry_id = $1", [entryId]), /append-only/);
  }));

test("reconciliation passes on true books and catches a fill the ledger never booked", () =>
  rolledBack(async (db) => {
    const client = await openAccount(db, "Ada");
    await creditCash(db, client, 1_000_000, ulid());
    await postFill(db, fill(client, "BUY", 100, 4210, 126));
    await settle(db, TODAY);
    const clean = await reconcile(db);
    assert.deepEqual(clean.discrepancies, []);
    assert.equal(clean.passed, true);

    // A fill recorded without its journal entry: positions, cash and fees all disagree.
    await db.query(
      `INSERT INTO broker.fills (fill_id, venue, exec_id, order_id, trade_id, account_id, symbol, side, qty,
         price_cents, notional_cents, fee_cents, currency, transact_ts_ns, business_date, settlement_date)
       VALUES ($1, 'ALPHA', $1, 'o', 't', $2, 'ACME', 'BUY', 5, 4210, 21050, 7, 'USD', 0, $3, $3)`,
      [ulid(), client, TODAY],
    );
    const broken = await reconcile(db);
    assert.equal(broken.passed, false);
    const checks = new Set(broken.discrepancies.map((d) => d.check));
    assert.ok(checks.has("positions_match_fills"));
    assert.ok(checks.has("cash_matches_fills"));
    assert.ok(checks.has("fees_match_fills"));
    const { rows } = await db.query("SELECT checks_passed FROM broker.reconciliation_runs WHERE run_id = $1", [broken.runId]);
    assert.equal(rows[0]?.checks_passed, false, "failed runs are recorded too");
  }));

test("1,000 random fills: the books balance and match an independent tally", () =>
  rolledBack(async (db) => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

    const symbols = ["ACME", "BLTZ", "CRUX", "GRID", "HELX"];
    // Fee revenue is house-wide, so measure this test's change, not the total.
    const revenueBefore = await db.query<{ balance: number }>(
      "SELECT balance FROM broker.account_balances WHERE account_type = 'FEES_REVENUE'",
    );
    const feesBefore = revenueBefore.rows[0]?.balance ?? 0;
    const clients: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) clients.push(await openAccount(db, `client ${n}`));
    const cash = new Map<string, number>();
    const shares = new Map<string, number>();
    let fees = 0;
    for (const client of clients) {
      const amount = 1 + Math.floor(random() * 50_000_000);
      await creditCash(db, client, amount, ulid());
      cash.set(client, amount);
    }

    for (let i = 0; i < 1000; i++) {
      const client = pick(clients);
      const symbol = pick(symbols);
      const side: Side = random() < 0.5 ? "BUY" : "SELL";
      const qty = 1 + Math.floor(random() * 500);
      const price = 100 + Math.floor(random() * 30_000);
      const fee = Math.floor(random() * 400) - 100; // sometimes a rebate
      await postFill(db, fill(client, side, qty, price, fee, symbol));
      const sign = side === "BUY" ? 1 : -1;
      cash.set(client, cash.get(client)! - sign * qty * price - fee);
      shares.set(`${client}/${symbol}`, (shares.get(`${client}/${symbol}`) ?? 0) + sign * qty);
      fees += fee;
      if (i % 250 === 0) await settle(db, TODAY); // settlement interleaved with trading
    }
    await settle(db, TODAY);
    await checkNow(db);

    for (const client of clients) {
      assert.equal(await cashBalance(db, client), cash.get(client), `cash for ${client}`);
      for (const holding of await holdings(db, client)) {
        assert.equal(holding.qtyUnsettled, 0, "everything due has settled");
        assert.equal(holding.qtySettled, shares.get(`${client}/${holding.symbol}`) ?? 0);
      }
      const held = (await holdings(db, client)).length;
      const expected = symbols.filter((s) => (shares.get(`${client}/${s}`) ?? 0) !== 0).length;
      assert.equal(held, expected, "no position missing or extra");
    }

    // Invariant 1: per asset, debits equal credits across the whole ledger.
    const { rows } = await db.query(
      "SELECT asset FROM broker.journal_lines GROUP BY asset HAVING sum(debit) <> sum(credit)",
    );
    assert.deepEqual(rows, []);
    // Invariant 2: reconciliation (positions and cash against fills) passes.
    const result = await reconcile(db);
    assert.deepEqual(result.discrepancies, []);
    const revenue = await db.query<{ balance: number }>(
      "SELECT balance FROM broker.account_balances WHERE account_type = 'FEES_REVENUE'",
    );
    assert.equal(revenue.rows[0]?.balance, feesBefore + fees);
  }));
