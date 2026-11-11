// Everything tunable, in one place: per-symbol personalities and the environment.

import { readFileSync } from "node:fs";

import type { Listing, Profile } from "./market/fair-value.ts";

/**
 * How each listed company behaves. Invented to match the names: a utility barely moves, a
 * biotech jumps on news. A ticker the venue lists but this table does not know gets the
 * default.
 */
const PROFILES: Record<string, Profile> = {
  ACME: { dailyVol: 0.025, jumpsPerDay: 2, jumpSize: 1.5 }, // industrial
  BLTZ: { dailyVol: 0.03, jumpsPerDay: 2, jumpSize: 1.5 }, // logistics
  CRUX: { dailyVol: 0.045, jumpsPerDay: 3, jumpSize: 2 }, // semiconductors
  DYNE: { dailyVol: 0.035, jumpsPerDay: 3, jumpSize: 1.5 }, // energy
  ECHO: { dailyVol: 0.025, jumpsPerDay: 2, jumpSize: 1.5 }, // telecoms
  FLUX: { dailyVol: 0.035, jumpsPerDay: 2, jumpSize: 1.5 }, // materials
  GRID: { dailyVol: 0.012, jumpsPerDay: 1, jumpSize: 1.5 }, // utility: the quiet one
  HELX: { dailyVol: 0.07, jumpsPerDay: 4, jumpSize: 2.5 }, // biotech: the wild one
  IONX: { dailyVol: 0.03, jumpsPerDay: 2, jumpSize: 1.5 }, // chemicals
  JOLT: { dailyVol: 0.018, jumpsPerDay: 1, jumpSize: 1.5 }, // consumer staples
};
const DEFAULT_PROFILE: Profile = { dailyVol: 0.03, jumpsPerDay: 2, jumpSize: 1.5 };

export function profileFor(ticker: string): Profile {
  return PROFILES[ticker] ?? DEFAULT_PROFILE;
}

interface PublishedListings {
  spec_version: string;
  venue: {
    code: string;
    order_entry: { host: string; port: number };
    market_data: { host: string; port: number };
  };
  symbols: {
    ticker: string;
    tick_size_cents: number;
    status: string;
    reference_price_cents: number;
    price_band_pct: number;
  }[];
}

export interface Config {
  venue: string;
  specVersion: string;
  fixHost: string;
  fixPort: number;
  feedUrl: string;
  compId: string;
  listings: Listing[];
  /** Seeds the random number generator; the same seed replays the same price paths. */
  seed: number;
  /** Ceiling on orders and cancels per second, across every agent. */
  maxOrdersPerSec: number;
  /** Multiplies how often the takers trade. 0.2 for a quiet deployed instance. */
  activity: number;
  /** Runs fair value this many times faster than the clock, to see hours in minutes. */
  speed: number;
  /** Seconds between status reports. */
  reportSecs: number;
  /** Where open orders are saved, so a restart can cancel what a crash left resting. */
  stateFile: string;
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function number(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

export function loadConfig(): Config {
  const path = new URL("../vendor/exchange-alpha/listings.json", import.meta.url);
  const published = JSON.parse(readFileSync(path, "utf8")) as PublishedListings;
  const { order_entry: fix, market_data: feed } = published.venue;
  return {
    venue: published.venue.code,
    specVersion: published.spec_version,
    fixHost: env("SIM_FIX_HOST", fix.host),
    fixPort: number("SIM_FIX_PORT", fix.port),
    feedUrl: env("SIM_FEED_URL", `ws://${feed.host}:${feed.port}`),
    compId: env("SIM_COMP_ID", "SIM"),
    listings: published.symbols
      .filter((s) => s.status === "ACTIVE")
      .map((s) => ({
        ticker: s.ticker,
        tickCents: s.tick_size_cents,
        referenceCents: s.reference_price_cents,
        bandPct: s.price_band_pct,
      })),
    seed: number("SIM_SEED", Date.now() % 2 ** 31),
    maxOrdersPerSec: number("SIM_MAX_ORDERS_PER_SEC", 40),
    activity: number("SIM_ACTIVITY", 1),
    speed: number("SIM_SPEED", 1),
    reportSecs: number("SIM_REPORT_SECS", 30),
    stateFile: env("SIM_STATE_FILE", new URL("../data/open-orders.json", import.meta.url).pathname),
  };
}
