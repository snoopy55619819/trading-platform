// How often news happens, over long seeded runs: the rates the plan promises, per company,
// with good and bad news balanced and about a quarter of moving stories MAJOR.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Rng } from "../src/rng.ts";
import { MAJOR_SHARE, MOVING_PER_DAY, NEUTRAL_PER_DAY, Schedule, type Story } from "../src/schedule.ts";

const companies = [
  { ticker: "ACME", name: "Acme Industrial Corp" },
  { ticker: "GRID", name: "Gridline Utilities Corp" },
  { ticker: "HELX", name: "Helix Biosciences Inc" },
];

/**
 * `days` of steps of `stepSec`. A step holds at most one story of each kind per company, so
 * the step must be short next to the time between stories: one minute is plenty at rate 1.
 */
function run(days: number, seed: number, rate = 1, stepSec = 60): Story[] {
  const schedule = new Schedule(companies, rate, new Rng(seed));
  const stories: Story[] = [];
  for (let t = 0; t < days * 86_400; t += stepSec) stories.push(...schedule.step(stepSec));
  return stories;
}

const near = (actual: number, expected: number, within: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= expected * within, `${what}: ${actual}, expected about ${expected}`);

test("the same seed gives the same stories", () => {
  assert.deepEqual(run(2, 42), run(2, 42));
  assert.notDeepEqual(run(2, 42), run(2, 43));
});

test("rates per company: the base for most, double for the biotech, half for the utility", () => {
  const days = 60;
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
