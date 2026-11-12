// Everything tunable, from the environment, plus the companies to write about.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Company } from "./schedule.ts";

export interface Config {
  port: number;
  /** Multiplies every company's news rate. 1 for a real day; 20 to watch it work. */
  rate: number;
  /** Seeds which stories happen and when. Headline ids are never seeded. */
  seed: number;
  companies: Company[];
}

const VENDORED = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "exchange-alpha", "listings.json");

interface PublishedListings {
  symbols: { ticker: string; name: string; status: string; reference_price_cents: number }[];
}

/** The exchange's active listings, as companies to write about. */
export function companiesFrom(listings: PublishedListings): Company[] {
  return listings.symbols
    .filter((s) => s.status === "ACTIVE")
    .map((s) => ({ ticker: s.ticker, name: s.name, referenceCents: s.reference_price_cents }));
}

function number(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

export function loadConfig(): Config {
  const listings = JSON.parse(readFileSync(process.env.NEWS_LISTINGS ?? VENDORED, "utf8")) as PublishedListings;
  return {
    port: number("NEWS_PORT", 9890),
    rate: number("NEWS_RATE", 1),
    seed: number("NEWS_SEED", Math.floor(Math.random() * 2 ** 32)),
    companies: companiesFrom(listings),
  };
}
