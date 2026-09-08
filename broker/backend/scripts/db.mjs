// Connection helper for broker-backend. Reads standard PG* / DATABASE_URL from the environment.
// A local .env at the repo root is loaded only when PGHOST is unset, so a deployed
// environment is always the source of truth for its own config.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const SERVICE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SERVICE_ROOT, "..", "..");

if (!process.env.PGHOST && !process.env.DATABASE_URL) {
  try {
    for (const line of readFileSync(join(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      const key = m?.[1];
      const value = m?.[2];
      if (key && value !== undefined && !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* no .env - fine, we're probably deployed */
  }
}

export function connect() {
  return new pg.Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.PGHOST ?? "127.0.0.1",
          port: Number(process.env.PGPORT ?? 5432),
          user: process.env.PGUSER ?? "broker",
          password: process.env.PGPASSWORD ?? "broker",
          database: process.env.PGDATABASE ?? "broker",
        },
  );
}
