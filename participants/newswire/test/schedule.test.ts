// How often news happens, over long seeded runs: the rates the plan promises, per company,
// with good and bad news balanced and about a quarter of moving stories MAJOR.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Rng } from "../src/rng.ts";
import { MAJOR_SHARE, MOVING_PER_DAY, NEUTRAL_PER_DAY, Schedule, type Story } from "../src/schedule.ts";

const companies = [
  { ticker: "ACME", name: "Acme Industrial Corp", referenceCents: 4210 },
  { ticker: "GRID", name: "Gridline Utilities Corp", referenceCents: 3312 },
  { ticker: "HELX", name: "Helix Biosciences Inc", referenceCents: 725 },
];
const NOW = new Date("2026-11-12T12:00:00Z");

/**
 * `days` of steps of `stepSec`. A step holds at most one story of each kind per company, so
 * the step must be short next to the time between stories: one minute is plenty at rate 1.
 */
function run(days: number, seed: number, rate = 1, stepSec = 60): Story[] {
  const schedule = new Schedule(companies, rate, new Rng(seed));
  const stories: Story[] = [];
  for (let t = 0; t < days * 86_400; t += stepSec) stories.push(...schedule.step(stepSec, new Date(NOW.getTime() + t * 1000)));
  return stories;
}

const near = (actual: number, expected: number, within: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= expected * within, `${what}: ${actual}, expected about ${expected}`);

test("the same seed gives the same stories", () => {
  assert.deepEqual(run(2, 42), run(2, 42));
  assert.notDeepEqual(run(2, 42), run(2, 43));
});

test("rates per company: the base for most, double for the biotech, half for the utility", () => {
  const days = 120;
  const stories = run(days, 1);
  const of = (ticker: string, moving: boolean) =>
    stories.filter((s) => s.symbol === ticker && (s.tone !== "NEUTRAL") === moving).length;
  near(of("ACME", true), MOVING_PER_DAY * days, 0.1, "ACME moving");
  near(of("ACME", false), NEUTRAL_PER_DAY * days, 0.1, "ACME neutral");
  near(of("HELX", true), MOVING_PER_DAY * days * 2, 0.1, "HELX moving");
  near(of("GRID", true), MOVING_PER_DAY * days * 0.5, 0.15, "GRID moving");
});

test("good and bad news balance, a quarter of it MAJOR, and neutral news is always MINOR", () => {
  const stories = run(60, 2);
  const moving = stories.filter((s) => s.tone !== "NEUTRAL");
  near(moving.filter((s) => s.tone === "POSITIVE").length, moving.length / 2, 0.08, "positive");
  near(moving.filter((s) => s.severity === "MAJOR").length, moving.length * MAJOR_SHARE, 0.12, "MAJOR");
  assert.ok(stories.filter((s) => s.tone === "NEUTRAL").every((s) => s.severity === "MINOR"));
});

test("the rate setting multiplies everything, to watch it work", () => {
  // 3.5: ACME at 1, GRID at 0.5, HELX at 2.
  near(run(1, 3, 20, 2).length, (MOVING_PER_DAY + NEUTRAL_PER_DAY) * 3.5 * 20, 0.06, "stories at rate 20");
});

test("news follows the day: busy before the open and after the close, quiet overnight", async () => {
  const { newsHours } = await import("../src/hours.ts");
  // 2026-11-12 is a winter day: New York is UTC-5.
  const at = (hhmm: string) => newsHours(new Date(`2026-11-12T${hhmm}:00Z`));
  assert.ok(at("13:00") > 2 && at("22:00") > 2, "08:00 and 17:00 New York"); // before the open, after the close
  assert.ok(at("17:00") > 1 && at("17:00") < 1.3, "noon New York");
  assert.ok(at("08:00") < 0.3, "03:00 New York");
  // Averages 1 over a day, so a day still has the same number of stories.
  let sum = 0;
  for (let m = 0; m < 1440; m++) sum += newsHours(new Date(Date.parse("2026-11-12T00:00:00Z") + m * 60_000));
  assert.ok(Math.abs(sum / 1440 - 1) < 1e-9);
});
