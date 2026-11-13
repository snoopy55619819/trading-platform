// The realism measures (realism/stats.ts) on series whose answer is known: a step, a
// gradual move, normal shocks, clustered shocks.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Rng } from "../src/market/rng.ts";
import {
  type Candle,
  autocorrelation,
  excessKurtosis,
  flatness,
  logReturns,
  measure,
  minutes,
  newsResponse,
} from "../realism/stats.ts";

const T0 = Date.parse("2026-11-13T14:30:00Z");
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const candle = (minute: number, closeCents: number, volume = 100): Candle => ({ t: at(minute), closeCents, volume });

test("a minute with no trades is the previous close with no volume", () => {
  const series = minutes([candle(0, 1000), candle(3, 1010)]);
  assert.deepEqual(
    series.map((m) => [m.closeCents, m.volume]),
    [[1000, 100], [1000, 0], [1000, 0], [1010, 100]],
  );
  assert.deepEqual(flatness(logReturns(series)), { flatShare: 2 / 3, longestFlat: 2 });
});

test("normal shocks have no excess kurtosis; rare big ones have a lot", () => {
  const rng = new Rng(5);
  const normal = Array.from({ length: 100_000 }, () => rng.normal());
  assert.ok(Math.abs(excessKurtosis(normal)) < 0.1, `${excessKurtosis(normal)}`);
  const jumpy = normal.map((x, i) => (i % 200 === 0 ? x * 20 : x));
  assert.ok(excessKurtosis(jumpy) > 10, `${excessKurtosis(jumpy)}`);
});

test("independent shocks do not cluster; shocks in busy and quiet stretches do", () => {
  const rng = new Rng(8);
  const independent = Array.from({ length: 20_000 }, () => rng.normal());
  assert.ok(Math.abs(autocorrelation(independent.map(Math.abs), 5)) < 0.03);
  // 100 minutes busy, 100 quiet, over and over: big moves follow big moves.
  const clustered = independent.map((x, i) => x * (Math.floor(i / 100) % 2 ? 3 : 0.5));
  assert.ok(autocorrelation(clustered.map(Math.abs), 5) > 0.2);
  // Neither predicts the direction of the next move.
  assert.ok(Math.abs(autocorrelation(clustered, 1)) < 0.05);
});

test("after news, a step moves the same at every minute; a gradual move builds", () => {
  const flat = Array.from({ length: 60 }, (_, m) => candle(m, 1000));
  // Good news at minute 10. A step: 1000 to 1100 at once.
  const step = flat.map((c, m) => (m >= 10 ? { ...c, closeCents: 1100 } : c));
  const stepped = newsResponse(minutes(step), [{ ts: at(10), sign: 1 }]);
  const jump = Math.log(1.1) * 10_000;
  for (const m of [1, 2, 5, 10, 30]) assert.ok(Math.abs(stepped.path[m]! - jump) < 1e-6);
  // All the movement there is came right after the headline.
  assert.equal(stepped.newsShare, 1);

  // Bad news, and the price falls 10 cents a minute for 10 minutes: counted as up, and building.
  const slide = flat.map((c, m) => ({ ...c, closeCents: 1000 - 10 * Math.min(10, Math.max(0, m - 9)) }));
  const sliding = newsResponse(minutes(slide), [{ ts: at(10), sign: -1 }]);
  assert.ok(sliding.path[1]! > 0 && sliding.path[1]! < sliding.path[5]! && sliding.path[5]! < sliding.path[10]!);
  // Only the first 5 of the 10 falling minutes are in the news window.
  assert.ok(sliding.newsShare > 0.4 && sliding.newsShare < 0.6, `${sliding.newsShare}`);
});

test("measure puts it together for one symbol", () => {
  const rng = new Rng(2);
  let price = 5000;
  const candles = Array.from({ length: 600 }, (_, m) => candle(m, (price = Math.max(1, Math.round(price * Math.exp(0.002 * rng.normal()))))));
  const r = measure(candles, []);
  assert.equal(r.minutes, 600);
  assert.ok(r.volBps > 15 && r.volBps < 25, `${r.volBps}`);
  assert.equal(r.news.events, 0);
});
