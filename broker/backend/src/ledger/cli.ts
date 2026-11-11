// Drive and inspect the ledger by hand, until the OMS (milestone 6) is its real caller.
//
//   pnpm ledger open "Ada Lovelace"                       open a client account, print its id
//   pnpm ledger deposit <account> 10000.00                credit cash
//   pnpm ledger fill <account> BUY 100 ACME 42.10 [fee]   book a fill as if one had arrived
//   pnpm ledger settle [YYYY-MM-DD]                       run the settle job (default today)
//   pnpm ledger show <account>                            cash and holdings, derived
//   pnpm ledger recon                                     reconcile and record the run
//
// Each command is one transaction.

import { createPool, transaction } from "../db.ts";
import type { Side } from "../domain/index.ts";
import { ulid } from "../ids.ts";
import { cashBalance, creditCash, holdings, openAccount, postFill, reconcile, settle } from "./index.ts";

/** "42.10" -> 4210, exactly. Dollars and cents, no float. */
function cents(text: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`not an amount in dollars: ${text}`);
  const [, sign, whole, fraction = ""] = match;
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -value : value;
}

function dollars(value: number): string {
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 100).toLocaleString("en-US");
  return `${value < 0 ? "-" : ""}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

const [command, ...args] = process.argv.slice(2);
const pool = createPool();
const today = new Date().toISOString().slice(0, 10);

try {
  await transaction(pool, async (db) => {
    switch (command) {
      case "open": {
        console.log(await openAccount(db, args[0] ?? "unnamed"));
        break;
      }
      case "deposit": {
        const [account, amount] = args;
        if (!account || !amount) throw new Error("usage: deposit <account> <dollars>");
        await creditCash(db, account, cents(amount), ulid());
        console.log(`deposited ${dollars(cents(amount))}`);
        break;
      }
      case "fill": {
        const [account, side, qty, symbol, price, fee = "0"] = args;
        if (!account || (side !== "BUY" && side !== "SELL") || !qty || !symbol || !price) {
          throw new Error("usage: fill <account> BUY|SELL <qty> <symbol> <price> [fee]");
        }
        const quantity = Number(qty);
        const { entryId } = await postFill(db, {
          fillId: ulid(), execId: ulid(), tradeId: ulid(), orderId: "manual",
          accountId: account, venue: "ALPHA", symbol, side: side as Side, qty: quantity,
          priceCents: cents(price), notionalCents: quantity * cents(price), feeCents: cents(fee),
          currency: "USD", transactTsNs: BigInt(Date.now()) * 1_000_000n, businessDate: today,
        });
        console.log(`booked entry ${entryId}`);
        break;
      }
      case "settle": {
        console.log(`settled ${await settle(db, args[0] ?? today)} fill(s)`);
        break;
      }
      case "show": {
        const account = args[0];
        if (!account) throw new Error("usage: show <account>");
        console.log(`cash ${dollars(await cashBalance(db, account))}`);
        for (const h of await holdings(db, account)) {
          console.log(`${h.symbol.padEnd(6)} settled ${h.qtySettled}  unsettled ${h.qtyUnsettled}`);
        }
        break;
      }
      case "recon": {
        const result = await reconcile(db);
        const verdict = result.passed ? "all checks passed" : "FAILED";
        console.log(`reconciliation ${result.runId}: ${verdict}`);
        for (const d of result.discrepancies) console.log(`  ${d.check}: ${JSON.stringify(d.detail)}`);
        if (!result.passed) process.exitCode = 1;
        break;
      }
      default:
        throw new Error("commands: open, deposit, fill, settle, show, recon");
    }
  });
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
