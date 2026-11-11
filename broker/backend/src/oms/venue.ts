// What the broker knows about Alpha Exchange, from its own vendored copy of the published
// listings: where to connect, what it charges, when its business day rolls.

import { readFileSync } from "node:fs";

interface Published {
  venue: {
    code: string;
    maker_fee_bps: number;
    taker_fee_bps: number;
    order_entry: { host: string; port: number };
  };
  market: { business_date_roll_utc: string };
}

const published = JSON.parse(
  readFileSync(new URL("../../vendor/exchange-alpha/listings.json", import.meta.url), "utf8"),
) as Published;

export const VENUE = published.venue.code;
export const ORDER_ENTRY = published.venue.order_entry;
/** The higher of the two fees, for reserving cash before we know which applies. */
export const WORST_FEE_BPS = Math.max(published.venue.maker_fee_bps, published.venue.taker_fee_bps);

const rollHourUtc = Number(published.market.business_date_roll_utc.slice(0, 2));

/**
 * The business date a moment belongs to. The venue's day rolls at 21:00 UTC (after the New
 * York close), so a trade at 22:00 UTC on the 11th belongs to the 12th. Not the UTC date.
 */
export function businessDate(now: Date): string {
  const shifted = new Date(now.getTime() + (24 - rollHourUtc) * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}
