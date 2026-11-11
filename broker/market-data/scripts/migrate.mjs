// Applies migrations/*.sql to market-data's own database, in filename order, exactly once.
//
//   node scripts/migrate.mjs            apply anything pending
//   node scripts/migrate.mjs --status   report only
//
// This service's own runner, deliberately not shared with the backend's: two deployables
// that share migration tooling are coupled through it, and this one may move to a
// different database entirely.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const statusOnly = process.argv.includes("--status");
const dir = new URL("../migrations/", import.meta.url);
const db = new pg.Client(
  process.env.MD_DATABASE_URL ?? "postgres://market_data:market_data@127.0.0.1:5434/market_data",
);
await db.connect();

await db.query("CREATE SCHEMA IF NOT EXISTS market_data");
await db.query(`CREATE TABLE IF NOT EXISTS market_data.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL)`);
const { rows } = await db.query("SELECT version, checksum FROM market_data.schema_migrations");
const applied = new Map(rows.map((r) => [r.version, r.checksum]));

let count = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const version = file.replace(/\.sql$/, "");
  const sql = readFileSync(new URL(file, dir), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const seen = applied.get(version);
  if (seen === checksum) {
    if (statusOnly) console.log(`applied  ${version}`);
    continue;
  }
  if (seen) {
    console.error(`ERROR  ${version} was modified after being applied`);
    process.exit(1);
  }
  if (statusOnly) {
    console.log(`PENDING  ${version}`);
    continue;
  }
  console.log(`applying ${version}`);
  await db.query("BEGIN");
  try {
    await db.query(sql);
    await db.query("INSERT INTO market_data.schema_migrations (version, checksum) VALUES ($1, $2)", [version, checksum]);
    await db.query("COMMIT");
    count++;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
if (!statusOnly) console.log(count ? `applied ${count}` : "nothing to apply");
await db.end();
