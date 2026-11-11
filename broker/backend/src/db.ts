// The backend's connection to its own database, and the one way to run a transaction.
//
// Reads DATABASE_URL, or PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE, defaulting to
// the local container from broker/compose.yml.

import pg from "pg";

// bigint columns (cents, shares) arrive as strings by default, because a JavaScript number
// cannot hold every int8. Ours are cents and share counts, far inside the exact range, so
// convert them, and refuse loudly if one ever is not.
pg.types.setTypeParser(pg.types.builtins.INT8, (text) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`int8 ${text} is too large to handle exactly`);
  return value;
});

/** Anything that can run a query: a pool, or a client inside a transaction. */
export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export function createPool(): pg.Pool {
  const env = process.env;
  return new pg.Pool(
    env.DATABASE_URL
      ? { connectionString: env.DATABASE_URL }
      : {
          host: env.PGHOST ?? "127.0.0.1",
          port: Number(env.PGPORT ?? 5432),
          user: env.PGUSER ?? "broker",
          password: env.PGPASSWORD ?? "broker",
          database: env.PGDATABASE ?? "broker",
        },
  );
}

/** Runs `work` in one transaction: committed if it returns, rolled back if it throws. */
export async function transaction<T>(pool: pg.Pool, work: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
