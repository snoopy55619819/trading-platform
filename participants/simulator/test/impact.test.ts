// Trading moves the price (market/model/impact.ts): the square-root law, a part that stays
// and a part that fades, and a volume estimate taken from the tape.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FADE_HALF_LIFE_SEC,
  ImpactLayer,
  LAMBDA,
  PERMANENT,
  VOLUME_WINDOW_SEC,
  WARM_UP_SEC,
} from "../src/market/model/impact.ts";
import type { Moment } from "../src/market/model/layer.ts";
import { Rng } from "../src/market/rng.ts";

const DAILY_VOL = 0.03;
const moment = (wallSec: number): Moment => ({ dtSec: wallSec, wallSec, activity: 1, logRatio: 0, rng: new Rng(1) });

/** A layer that has watched `perSec` shares a second trade for `seconds`. */
function warmed(perSec: number, seconds: number): ImpactLayer {
  const layer = new ImpactLayer(DAILY_VOL);
  for (let s = 0; s < seconds; s++) {
    layer.trade(perSec, s % 2 === 0); // alternate sides: no net push
    layer.advance(moment(1));
  }
  return layer;
}

test("no impact until it has seen enough of the tape to know a day's volume", () => {
  const layer = new ImpactLayer(DAILY_VOL);
  assert.equal(layer.trade(1000, true), 0);
  assert.equal(layer.dailyVolume(), undefined);
  const ready = warmed(10, WARM_UP_SEC + 1);
  assert.ok(ready.dailyVolume() !== undefined);
});

test("the volume estimate follows the tape's rate", () => {
  const layer = warmed(10, 3 * VOLUME_WINDOW_SEC);
  const perDay = 10 * 86_400;
  assert.ok(Math.abs(layer.dailyVolume()! / perDay - 1) < 0.02, `${layer.dailyVolume()} vs ${perDay}`);
});

test("buying pushes up, selling down, by the square root of size", () => {
  const layer = warmed(10, 3 * VOLUME_WINDOW_SEC);
  const volume = layer.dailyVolume()!;
  const up = layer.trade(volume / 100, true);
  // 1% of a day's volume: LAMBDA x sqrt(0.01) = a tenth of LAMBDA days' volatility.
  assert.ok(Math.abs(up - LAMBDA * 0.1 * DAILY_VOL) < 1e-4, `${up}`);
  const fresh = warmed(10, 3 * VOLUME_WINDOW_SEC);
  const small = fresh.trade(100, false);
  const big = fresh.trade(400, false);
  assert.ok(small < 0 && big < 0);
  // Four times the size, about twice the move (the estimate moved a little in between).
  assert.ok(Math.abs(big / small - 2) < 0.05, `${big / small}`);
});

test("part of a move stays and the rest fades over minutes", () => {
  const layer = warmed(10, 3 * VOLUME_WINDOW_SEC);
  // Let the warm-up trades' own fading impact die away first.
  for (let s = 0; s < 40 * FADE_HALF_LIFE_SEC; s += 60) layer.advance(moment(60));
  const move = layer.trade(5000, true);
  let undone = 0;
  for (let s = 0; s < FADE_HALF_LIFE_SEC; s++) {
    undone += layer.drift(moment(1));
    layer.advance(moment(1));
  }
  // After one half-life, half of the fading part has gone.
  assert.ok(Math.abs(undone + 0.5 * (1 - PERMANENT) * move) < 1e-9, `${undone}`);
  for (let s = 0; s < 20 * FADE_HALF_LIFE_SEC; s++) {
    undone += layer.drift(moment(1));
    layer.advance(moment(1));
  }
  // In the end only the permanent part is left.
  assert.ok(Math.abs(move + undone - PERMANENT * move) < 1e-5 * Math.abs(move));
});
