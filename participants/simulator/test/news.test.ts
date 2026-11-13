// What news does to the simulated market (ADR 0006): a lasting move the way the story
// says, a burst that fades, and the newswire's repeats dropped.

import assert from "node:assert/strict";
import { test } from "node:test";

import { profileFor } from "../src/config.ts";
import { FairValue } from "../src/market/fair-value.ts";
import {
  type Headline,
  HEAT_HALF_LIFE_SEC,
  cool,
  newsHeat,
  newsMove,
  quoteSizeMultiplier,
  tradeRateMultiplier,
  volMultiplier,
} from "../src/market/news.ts";
import { Rng } from "../src/market/rng.ts";
import { NewsDesk } from "../src/news/client.ts";

const acme = { ticker: "ACME", tickCents: 1, referenceCents: 4210, bandPct: 20 };
const story = (tone: Headline["tone"], severity: Headline["severity"]) => ({ tone, severity });

test("good news moves the price up, bad news down, neutral news not at all", () => {
  const rng = new Rng(1);
  const profile = profileFor("ACME");
  for (let i = 0; i < 1000; i++) {
    assert.ok(newsMove(story("POSITIVE", "MINOR"), profile, rng) > 0);
    assert.ok(newsMove(story("NEGATIVE", "MAJOR"), profile, rng) < 0);
    assert.equal(newsMove(story("NEUTRAL", "MINOR"), profile, rng), 0);
  }
});

test("MAJOR news moves more than MINOR, and the biotech more than the utility", () => {
  const rng = new Rng(2);
  const average = (f: () => number) => Array.from({ length: 2000 }, f).reduce((a, b) => a + Math.abs(b), 0) / 2000;
  const minor = average(() => newsMove(story("POSITIVE", "MINOR"), profileFor("ACME"), rng));
  const major = average(() => newsMove(story("POSITIVE", "MAJOR"), profileFor("ACME"), rng));
  assert.ok(Math.abs(major / minor - 0.35 / 0.12) < 0.12, `MAJOR ${major} vs MINOR ${minor}`);
  // ACME: 2.5% a day x 1.5 x 0.12 is about 0.45% for minor news.
  assert.ok(Math.abs(minor - 0.025 * 1.5 * 0.12) < 0.0005, `ACME minor ${minor}`);
  const helx = average(() => newsMove(story("NEGATIVE", "MINOR"), profileFor("HELX"), rng));
  const grid = average(() => newsMove(story("NEGATIVE", "MINOR"), profileFor("GRID"), rng));
  assert.ok(helx > 5 * grid, `HELX ${helx} vs GRID ${grid}`);
});

test("a day of news adds about one day of the walk's volatility: under half the movement", () => {
  // 10 moving stories a day, a quarter MAJOR (the newswire's rates), against the walk's one
  // day of the profile's variance (and trading on top). Before stage 4 it was nearly 5.
  const rng = new Rng(3);
  const profile = profileFor("ACME");
  let squares = 0;
  const days = 2000;
  for (let i = 0; i < days * 10; i++) {
    const move = newsMove(story(rng.next() < 0.5 ? "POSITIVE" : "NEGATIVE", rng.next() < 0.25 ? "MAJOR" : "MINOR"), profile, rng);
    squares += move * move;
  }
  const perDay = squares / days;
  const walk = profile.dailyVol ** 2;
  assert.ok(perDay / walk > 0.75 && perDay / walk < 1.2, `news ${perDay} vs a day of the walk ${walk}`);
});

test("a shock moves half at once, tells the market makers for one step, and heats up", () => {
  const fair = new FairValue(acme, profileFor("ACME"));
  const rng = new Rng(4);
  const before = fair.value();
  fair.shock(-0.03, newsHeat(story("NEGATIVE", "MAJOR")), rng);
  assert.ok(Math.abs(fair.value() / before - Math.exp(-0.015)) < 1e-9);
  assert.equal(fair.heat, 1);
  fair.step(0.25, 1, rng);
  assert.equal(fair.jumped, true, "the makers see it on the next step");
  fair.step(0.25, 1, rng);
  assert.equal(fair.jumped, false, "and only that one");
});

test("neutral news heats a little and moves nothing; heat never passes 1", () => {
  const fair = new FairValue(acme, profileFor("ACME"));
  const before = fair.value();
  fair.shock(0, newsHeat(story("NEUTRAL", "MINOR")), new Rng(5));
  assert.equal(fair.value(), before);
  assert.equal(fair.heat, 0.2);
  fair.step(0.25, 1, new Rng(5));
  assert.equal(fair.jumped, false, "no price change, so no pull");
  fair.shock(0.01, 1, new Rng(5));
  fair.shock(0.01, 1, new Rng(5));
  assert.equal(fair.heat, 1);
});

test("a shock never pushes fair value past the band", () => {
  const fair = new FairValue(acme, profileFor("ACME"));
  const rng = new Rng(7);
  for (let i = 0; i < 50; i++) fair.shock(0.1, 1, rng);
  for (let i = 0; i < 600; i++) fair.step(1, 1, rng); // and the rest arriving
  assert.ok(fair.value() <= 4210 * (1 + 0.2 * 0.75) + 1e-6, `${fair.value()}`);
});

test("the burst halves every 15 minutes, in wall-clock time, and is mostly gone in an hour", () => {
  assert.equal(cool(1, HEAT_HALF_LIFE_SEC), 0.5);
  assert.ok(cool(1, 3600) < 0.07);
  const fast = new FairValue(acme, profileFor("ACME"), 20); // SIM_SPEED=20
  fast.shock(0.01, 1, new Rng(6));
  for (let i = 0; i < HEAT_HALF_LIFE_SEC * 4; i++) fast.step(0.25, 1, new Rng(6)); // 15 minutes of steps
  assert.ok(Math.abs(fast.heat - 0.5) < 1e-9, `${fast.heat}`);
});

test("while hot: faster prices, busier and bigger takers, smaller quotes", () => {
  assert.equal(volMultiplier(0), 1);
  assert.equal(volMultiplier(1), 2.5);
  assert.equal(tradeRateMultiplier(1), 3.5);
  assert.equal(quoteSizeMultiplier(1), 0.6);
  const calm = new FairValue(acme, profileFor("ACME"));
  const hot = new FairValue(acme, profileFor("ACME"));
  hot.shock(0, 1, new Rng(8));
  assert.ok(Math.abs(hot.volPerSec(1) / calm.volPerSec(1) - 2.5) < 1e-9);
});

test("the newswire's repeats are dropped, and catch-up starts from the newest headline", () => {
  const desk = new NewsDesk(new Date("2026-11-12T14:00:00.000Z"));
  assert.equal(desk.since(), "2026-11-12T14:00:00.000Z", "the first time, from when we started");
  const h = (id: string, ts: string): Headline => ({
    id, ts, symbol: "ACME", headline: "x", category: "CONFERENCE", tone: "NEUTRAL", severity: "MINOR",
  });
  assert.equal(desk.accept(h("A", "2026-11-12T14:01:00.000Z")), true);
  assert.equal(desk.accept(h("A", "2026-11-12T14:01:00.000Z")), false, "the same id from catch-up");
  assert.equal(desk.accept(h("B", "2026-11-12T14:00:30.000Z")), true, "older but new to us");
  assert.equal(desk.since(), "2026-11-12T14:01:00.000Z");
});

test("news plays out over minutes: half at once, the rest arriving, overshoots given back", async () => {
  const { standardLayers } = await import("../src/market/model/layers.ts");
  const { OVERSHOOT_MAX } = await import("../src/market/model/news-layer.ts");
  // Without the random walk, so only the news is moving the price.
  const still = () => {
    const layers = standardLayers(profileFor("ACME"));
    layers.all.push({ name: "still", volatility: () => 0 });
    return new FairValue(acme, profileFor("ACME"), 1, layers);
  };
  let overshot = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const fair = still();
    const rng = new Rng(seed);
    const start = Math.log(fair.value());
    const moved = () => Math.log(fair.value()) - start;
    fair.shock(0.02, 1, rng);
    assert.ok(Math.abs(moved() - 0.01) < 1e-9, "half at once");
    let peak = moved();
    for (let s = 0; s < 3 * 3600; s++) {
      fair.step(1, 1, rng);
      peak = Math.max(peak, moved());
      if (s === 60) assert.ok(moved() > 0.01 && moved() < 0.02 * (1 + OVERSHOOT_MAX), `building at 1 min: ${moved()}`);
    }
    if (peak > 0.0205) overshot++;
    // Three hours on, it has settled at the move (less a little pull toward the reference).
    assert.ok(Math.abs(moved() - 0.02) < 0.0015, `settled at ${moved()}`);
  }
  // About 30% overshoot.
  assert.ok(overshot >= 6 && overshot <= 20, `${overshot} of 40 overshot`);
});
