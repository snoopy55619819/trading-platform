// The price process over long simulated runs: it must wander, stay inside the venue's
// price band, and give each symbol the personality it was configured with.

import assert from "node:assert/strict";
import { test } from "node:test";

import { profileFor } from "../src/config.ts";
import { FairValue, type Listing, toTick, withinBand } from "../src/market/fair-value.ts";
import { Rng } from "../src/market/rng.ts";

const listing = (ticker: string, referenceCents: number, bandPct: number): Listing => ({
  ticker,
  tickCents: 1,
  referenceCents,
  bandPct,
});

/** Simulates `days` of one-minute steps and returns daily closes. */
function run(fair: FairValue, days: number, seed: number): number[] {
  const rng = new Rng(seed);
  const closes: number[] = [];
  for (let minute = 0; minute < days * 1440; minute++) {
    fair.step(60, 1, rng);
    if (minute % 1440 === 1439) closes.push(fair.value());
  }
  return closes;
}

function dailyVol(closes: number[]): number {
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length);
}

test("a year of fair value stays inside the price band", () => {
  for (const [ticker, ref, band] of [["HELX", 725, 35], ["GRID", 3312, 10]] as const) {
    const fair = new FairValue(listing(ticker, ref, band), profileFor(ticker));
    const closes = run(fair, 365, 42);
    for (const close of closes) {
      assert.ok(withinBand(Math.round(close), fair.listing), `${ticker} at ${close}`);
    }
  }
});

test("fair value wanders rather than flatlining, and HELX moves far more than GRID", () => {
  const helx = dailyVol(run(new FairValue(listing("HELX", 725, 35), profileFor("HELX")), 120, 1));
  const grid = dailyVol(run(new FairValue(listing("GRID", 3312, 10), profileFor("GRID")), 120, 1));
  assert.ok(grid > 0.005, `GRID barely moves: ${grid}`);
  assert.ok(helx > 3 * grid, `HELX ${helx} vs GRID ${grid}`);
  // Realised volatility is near the configured figure (jumps add a little).
  assert.ok(grid > 0.6 * 0.012 && grid < 2 * 0.012, `GRID realised ${grid}`);
});

test("jumps happen, at roughly the configured rate", () => {
  const fair = new FairValue(listing("HELX", 725, 35), profileFor("HELX")); // 4 a day
  const rng = new Rng(3);
  let jumps = 0;
  for (let minute = 0; minute < 30 * 1440; minute++) {
    fair.step(60, 1, rng);
    if (fair.jumped) jumps += 1;
  }
  assert.ok(jumps > 80 && jumps < 160, `${jumps} jumps in 30 days`);
});

test("the same seed gives the same path", () => {
  const a = run(new FairValue(listing("ACME", 4210, 20), profileFor("ACME")), 5, 9);
  const b = run(new FairValue(listing("ACME", 4210, 20), profileFor("ACME")), 5, 9);
  assert.deepEqual(a, b);
});

test("prices round to the symbol's tick, never below one tick", () => {
  assert.equal(toTick(28_652.4, 5), 28_650);
  assert.equal(toTick(28_653, 5), 28_655);
  assert.equal(toTick(0.2, 1), 1);
});
