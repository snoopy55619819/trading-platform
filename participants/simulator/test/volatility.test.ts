// Stage 3 of the price model (ADR 0008): volatility with memory and fat tails. Run the model
// alone for weeks of one-minute steps and check the realism measures a real stock shows,
// against the same model without the two layers.

import assert from "node:assert/strict";
import { test } from "node:test";

import { profileFor } from "../src/config.ts";
import { WALK_DAY_SECONDS } from "../src/market/diurnal.ts";
import { FairValue } from "../src/market/fair-value.ts";
import { ImpactLayer } from "../src/market/model/impact.ts";
import { standardLayers } from "../src/market/model/layers.ts";
import { VolatilityMemory } from "../src/market/model/memory.ts";
import { NewsLayer } from "../src/market/model/news-layer.ts";
import { PullToReference } from "../src/market/model/pull.ts";
import { tailMultiplier } from "../src/market/model/tails.ts";
import { Rng } from "../src/market/rng.ts";
import { autocorrelation, excessKurtosis } from "../realism/stats.ts";

const ACME = { ticker: "ACME", tickCents: 1, referenceCents: 4210, bandPct: 20 };
const DAYS = 20;

/** One-minute log returns of fair value over DAYS, in market hours' activity. */
function minuteReturns(fair: FairValue, seed: number): number[] {
  const rng = new Rng(seed);
  const out: number[] = [];
  let last = Math.log(fair.value());
  for (let minute = 0; minute < DAYS * 1440; minute++) {
    fair.step(60, 1, rng);
    const now = Math.log(fair.value());
    out.push(now - last);
    last = now;
  }
  return out;
}

const profile = profileFor("ACME");
const plain = () => {
  const news = new NewsLayer();
  const impact = new ImpactLayer(profile.dailyVol);
  return new FairValue(ACME, profile, 1, { all: [new PullToReference(), news, impact], news, impact });
};

test("the tail multiplier averages 1, so daily volatility is unchanged", () => {
  const rng = new Rng(4);
  let sum = 0;
  for (let i = 0; i < 200_000; i++) sum += tailMultiplier(rng);
  assert.ok(Math.abs(sum / 200_000 - 1) < 0.02, `${sum / 200_000}`);
});

test("a big move makes the next minutes jumpier, fading over about half an hour", () => {
  const memory = new VolatilityMemory(0.03);
  const rng = new Rng(1);
  const minute = { dtSec: 60, wallSec: 60, activity: 1, logRatio: 0, band: { floor: -0.2, limit: 0.2 }, rng };
  const expected = 0.03 * Math.sqrt(60 / WALK_DAY_SECONDS);
  memory.advance(minute, 5 * expected); // a minute 25 times its usual variance
  const after = memory.volatility();
  assert.ok(after > 1.4, `${after}`);
  for (let i = 0; i < 30; i++) memory.advance(minute, expected); // ordinary minutes
  assert.ok(memory.volatility() < after && memory.volatility() > 1, `${memory.volatility()}`);
  for (let i = 0; i < 300; i++) memory.advance(minute, expected);
  assert.ok(Math.abs(memory.volatility() - 1) < 0.01);
});

test("with the two layers, minutes have fat tails and cluster; without, neither", () => {
  const before = minuteReturns(plain(), 11);
  const after = minuteReturns(new FairValue(ACME, profile, 1, standardLayers(profile)), 11);
  const clustering = (rs: number[]) => autocorrelation(rs.map(Math.abs), 15);
  // Without: normal minutes, no memory.
  assert.ok(Math.abs(excessKurtosis(before)) < 0.3, `before kurtosis ${excessKurtosis(before)}`);
  assert.ok(Math.abs(clustering(before)) < 0.03, `before clustering ${clustering(before)}`);
  // With: in the range of a real stock, and clustering that lasts.
  assert.ok(excessKurtosis(after) > 4, `after kurtosis ${excessKurtosis(after)}`);
  assert.ok(clustering(after) > 0.05, `after clustering ${clustering(after)}`);
  assert.ok(autocorrelation(after.map(Math.abs), 60) > 0.02);
  // Still no predictable direction.
  assert.ok(Math.abs(autocorrelation(after, 1)) < 0.03);
  // And about the same volatility overall.
  const sd = (rs: number[]) => Math.sqrt(rs.reduce((a, r) => a + r * r, 0) / rs.length);
  assert.ok(sd(after) / sd(before) > 0.8 && sd(after) / sd(before) < 1.3, `${sd(after) / sd(before)}`);
});
