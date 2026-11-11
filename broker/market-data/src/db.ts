// market-data's connection to its own database (not the backend's: a different server,
// role and schema). MD_DATABASE_URL overrides the local default.

import pg from "pg";

// bigint columns hold cents, sizes and sequence numbers, all far inside the exact range of
// a JavaScript number. Convert them, and refuse loudly if one ever is not.
pg.types.setTypeParser(pg.types.builtins.INT8, (text) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`int8 ${text} is too large to handle exactly`);
  return value;
});

export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function createPool(): pg.Pool {
  return new pg.Pool({
    connectionString: process.env.MD_DATABASE_URL ?? "postgres://market_data:market_data@127.0.0.1:5434/market_data",
  });
}
