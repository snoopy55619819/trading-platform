// Loads the backend's security master from its own vendored copy of the exchange's
// published listings. market-data vendors the same file separately - neither reads the
// other's copy, and neither reads the other's database.
//
//   node scripts/seed-securities.mjs            upsert
//   node scripts/seed-securities.mjs --check    report drift, change nothing
//
// This is DATA, deliberately not part of any deploy step: wiring it into a release job
// would let an unrelated deploy silently rewrite production instruments. Run --check in
// CI to catch drift, and run the upsert as a considered action.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, SERVICE_ROOT } from "./db.mjs";

/**
 * The shape of the exchange's published listings. Written out rather than inferred
 * because JSON.parse returns `any`, and this file is the boundary where an external
 * document becomes typed data.
 *
 * @typedef {{ ticker: string, name: string, tick_size_cents: number, lot_size: number,
 *             currency: string, status: string, reference_price_cents: number,
 *             price_band_pct: number }} Listing
 * @typedef {{ venue: { code: string }, symbols: Listing[] }} Listings
 */

const check = process.argv.includes("--check");
/** @type {Listings} */
const listings = JSON.parse(
  readFileSync(join(SERVICE_ROOT, "vendor/exchange-alpha/listings.json"), "utf8"),
);
const venue = listings.venue.code;
const db = connect();
await db.connect();

const { rows: existing } = await db.query("SELECT ticker FROM broker.securities");
const known = new Set(existing.map((r) => r.ticker));
const drift = [];

for (const s of listings.symbols) {
  if (s.reference_price_cents % s.tick_size_cents !== 0) {
    throw new Error(`${s.ticker}: reference_price_cents is not on a valid tick`);
  }
  if (check) {
    if (!known.has(s.ticker)) drift.push(`missing from db: ${s.ticker}`);
    continue;
  }
  await db.query(
    `INSERT INTO broker.securities
       (ticker, name, venue, tick_size_cents, lot_size, currency, status,
        reference_price_cents, price_band_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (ticker) DO UPDATE SET
       name = EXCLUDED.name, venue = EXCLUDED.venue,
       tick_size_cents = EXCLUDED.tick_size_cents, lot_size = EXCLUDED.lot_size,
       currency = EXCLUDED.currency, status = EXCLUDED.status,
       reference_price_cents = EXCLUDED.reference_price_cents,
       price_band_pct = EXCLUDED.price_band_pct, updated_at = now()`,
    [s.ticker, s.name, venue, s.tick_size_cents, s.lot_size, s.currency, s.status,
     s.reference_price_cents, s.price_band_pct],
  );
}

if (check) {
  for (const t of known) {
    if (!listings.symbols.some((s) => s.ticker === t)) drift.push(`not listed by ${venue}: ${t}`);
  }
  if (drift.length) {
    console.error("security master DRIFT:");
    for (const d of drift) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log("security master in sync");
} else {
  console.log(`seeded ${listings.symbols.length} securities from ${venue}`);
}
await db.end();
