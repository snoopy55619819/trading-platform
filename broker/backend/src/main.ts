// The broker's backend: one process holding the api, oms, ledger and fix modules.
//
//     pnpm start
//
// Needs its database (pnpm db:up, db:migrate, db:seed) and, to send orders anywhere, Alpha
// Exchange. Without the exchange it still runs: orders are refused as VENUE_UNAVAILABLE and
// it keeps trying to connect.
//
// Configuration, all optional:
//   BROKER_API_PORT   8080
//   BROKER_COMP_ID    BROKER   (must be in the exchange's ALPHA_COMP_IDS)
//   FIX_HOST / FIX_PORT        from the vendored listings.json
//   PG* / DATABASE_URL         see src/db.ts

import { createApi } from "./api/server.ts";
import { createPool, transaction } from "./db.ts";
import { Initiator } from "./fix/initiator.ts";
import { reconcile, settle } from "./ledger/index.ts";
import { Oms } from "./oms/service.ts";
import { ORDER_ENTRY, VENUE, businessDate } from "./oms/venue.ts";

const SETTLE_EVERY_MS = 1000;
const RECONCILE_EVERY_MS = 3_600_000;

const pool = createPool();
const oms = new Oms(pool);
const fix = await Initiator.open(
  {
    sender: process.env.BROKER_COMP_ID ?? "BROKER",
    target: VENUE,
    heartbeatSecs: 30,
    host: process.env.FIX_HOST ?? ORDER_ENTRY.host,
    port: Number(process.env.FIX_PORT ?? ORDER_ENTRY.port),
  },
  pool,
  { onMessage: (db, message) => oms.onMessage(db, message), onActive: () => oms.onActive() },
);
oms.attach(fix);
fix.start();

const port = Number(process.env.BROKER_API_PORT ?? 8080);
const api = createApi(pool, oms).listen(port, () => console.log(`api: listening on http://127.0.0.1:${port}`));

// The settle job. v1 settles on the trade date, so this books fills within a second.
const settler = setInterval(() => {
  transaction(pool, (db) => settle(db, businessDate(new Date())))
    .then((n) => n > 0 && console.log(`ledger: settled ${n} fill(s)`))
    .catch((e: Error) => console.error(`ledger: settle failed: ${e.message}`));
}, SETTLE_EVERY_MS);

async function reconcileNow(): Promise<void> {
  const result = await transaction(pool, (db) => reconcile(db));
  if (result.passed) console.log(`ledger: reconciliation ${result.runId} passed`);
  else console.error(`ledger: reconciliation ${result.runId} FAILED: ${JSON.stringify(result.discrepancies)}`);
}
await reconcileNow().catch((e: Error) => console.error(`ledger: reconciliation failed: ${e.message}`));
const reconciler = setInterval(() => void reconcileNow().catch(() => {}), RECONCILE_EVERY_MS);

async function shutdown(): Promise<void> {
  console.log("backend: shutting down");
  clearInterval(settler);
  clearInterval(reconciler);
  api.close();
  await fix.stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
