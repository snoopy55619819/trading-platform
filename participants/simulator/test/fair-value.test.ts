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
  // With no news, realised volatility is near the configured figure.
  assert.ok(grid > 0.6 * 0.012 && grid < 2 * 0.012, `GRID realised ${grid}`);
});

test("no jumps of its own: without news, nothing ever gaps", () => {
  const fair = new FairValue(listing("HELX", 725, 35), profileFor("HELX"));
  const rng = new Rng(3);
  for (let minute = 0; minute < 30 * 1440; minute++) {
    fair.step(60, 1, rng);
    assert.equal(fair.jumped, false);
  }
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

test("the price is built from layers, and a new one plugs in without touching the rest", async () => {
  const { standardLayers } = await import("../src/market/model/layers.ts");
  const ref = listing("ACME", 4210, 20);
  assert.deepEqual(new FairValue(ref, profileFor("ACME")).layerNames, [
    "pull to reference",
    "news",
    "trading impact",
    "volatility memory",
    "fat tails",
  ]);

  // A layer that stops the walk and drifts up a fixed amount each step: fair value then
  // follows the drift alone.
  const layers = standardLayers(profileFor("ACME"));
  layers.all.push({ name: "test", volatility: () => 0, drift: () => 0.001 });
  const fair = new FairValue(ref, profileFor("ACME"), 1, layers);
  const rng = new Rng(1);
  for (let i = 0; i < 10; i++) fair.step(1, 1, rng);
  assert.ok(Math.abs(fair.value() - 4210 * Math.exp(0.01)) < 0.01, `at ${fair.value()}`);
  assert.equal(fair.volPerSec(1), 0);
});

test("the soft band: prices turn back before the edge instead of lying flat against it", () => {
  // CRUX has the narrowest band for its volatility. Two years of minutes.
  const crux = { ticker: "CRUX", tickCents: 5, referenceCents: 28_650, bandPct: 15 };
  const fair = new FairValue(crux, profileFor("CRUX"));
  const rng = new Rng(3);
  const limit = Math.log(1 + 0.15 * 0.75);
  const floor = Math.log(1 - 0.15 * 0.75);
  let pinned = 0;
  for (let minute = 0; minute < 2 * 365 * 1440; minute++) {
    fair.step(60, 0.65, rng); // about a day's average activity
    const x = Math.log(fair.value() / crux.referenceCents);
    if (x >= limit - 1e-9 || x <= floor + 1e-9) pinned++;
  }
  assert.equal(pinned, 0);
});
