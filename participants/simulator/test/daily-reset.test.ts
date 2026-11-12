import assert from "node:assert/strict";
import { test } from "node:test";

import { nextSessionReset, timeOfDayMs } from "../src/fix/daily-reset.ts";

const MIDNIGHT = Date.UTC(2026, 10, 12); // 2026-11-12 00:00 UTC
const ROLL = 21 * 3_600_000;

test("the reset is at the next roll time, never now or in the past", () => {
  assert.equal(nextSessionReset(MIDNIGHT, "21:00:00"), MIDNIGHT + ROLL);
  assert.equal(nextSessionReset(MIDNIGHT + ROLL - 1, "21:00:00"), MIDNIGHT + ROLL);
  assert.equal(nextSessionReset(MIDNIGHT + ROLL, "21:00:00"), MIDNIGHT + ROLL + 86_400_000);
  assert.equal(nextSessionReset(MIDNIGHT + ROLL + 1, "21:00:00"), MIDNIGHT + ROLL + 86_400_000);
});

test("a reset interval, when set, replaces the daily time", () => {
  assert.equal(nextSessionReset(MIDNIGHT, "21:00:00", 30), MIDNIGHT + 30_000);
});

test("the roll time is read strictly", () => {
  assert.equal(timeOfDayMs("21:00:00"), ROLL);
  assert.equal(timeOfDayMs("00:00:01"), 1000);
  assert.throws(() => timeOfDayMs("21:00"));
  assert.throws(() => timeOfDayMs("24:00:00"));
});
