import assert from "node:assert/strict";
import { test } from "node:test";

import { Rng } from "../src/market/rng.ts";

test("count averages rate times time, small or large, and is never negative", () => {
  for (const [rate, dt] of [[0.4, 0.25], [8, 0.25], [400, 0.25]] as const) {
    const rng = new Rng(7);
    let total = 0;
    for (let i = 0; i < 20_000; i++) {
      const n = rng.count(rate, dt);
      assert.ok(n >= 0 && Number.isInteger(n));
      total += n;
    }
    const mean = total / 20_000;
    assert.ok(Math.abs(mean - rate * dt) < 0.05 * rate * dt + 0.01, `rate ${rate}: mean ${mean}`);
  }
});

test("count is at least one as often as chance says an event happened", () => {
  const rng = new Rng(3);
  let some = 0;
  for (let i = 0; i < 50_000; i++) if (rng.count(1, 0.25) > 0) some += 1;
  assert.ok(Math.abs(some / 50_000 - (1 - Math.exp(-0.25))) < 0.01);
});
