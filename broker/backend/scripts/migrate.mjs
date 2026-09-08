// Applies broker/migrations/*.sql, in filename order, exactly once each.
//
//   node scripts/migrate.mjs            apply anything pending
//   node scripts/migrate.mjs --status   report only
//
// This service owns the `broker` schema in its own database, and nothing else. Its
// migration history lives in that schema, so it migrates and deploys without coordinating
// with market-data, the exchange, or anything else.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, SERVICE_ROOT } from "./db.mjs";

const statusOnly = process.argv.includes("--status");
const dir = join(SERVICE_ROOT, "migrations");
const db = connect();
await db.connect();

await db.query("CREATE SCHEMA IF NOT EXISTS broker");
await db.query(`CREATE TABLE IF NOT EXISTS broker.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL)`);

const { rows } = await db.query("SELECT version, checksum FROM broker.schema_migrations");
const applied = new Map(rows.map((r) => [r.version, r.checksum]));

let count = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const version = file.replace(/\.sql$/, "");
  const sql = readFileSync(join(dir, file), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const seen = applied.get(version);

  if (seen === checksum) {
    if (statusOnly) console.log(`applied  ${version}`);
    continue;
  }
  if (seen) {
    // The file and the database have diverged; re-running cannot reconcile them.
    console.error(`ERROR  ${version} was modified after being applied`);
    console.error(`       recorded ${seen.slice(0, 12)}  file ${checksum.slice(0, 12)}`);
    process.exit(1);
  }
  if (statusOnly) {
    console.log(`PENDING  ${version}`);
    continue;
  }

  // Migration and bookkeeping commit together, so a failure part-way through cannot
  // leave the ledger claiming a migration that did not fully apply.
  console.log(`applying ${version}`);
  await db.query("BEGIN");
  try {
    await db.query(sql);
    await db.query("INSERT INTO broker.schema_migrations (version, checksum) VALUES ($1, $2)",
      [version, checksum]);
    await db.query("COMMIT");
    count++;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

if (!statusOnly) console.log(count ? `applied ${count}` : "nothing to apply");
await db.end();
