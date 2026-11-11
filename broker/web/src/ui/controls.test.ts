// The quantity stepper's arithmetic, and that every style names a variant for each section.

import { describe, expect, test } from "vitest";

import { STYLES } from "../theme/theme.ts";
import { VARIANTS } from "../theme/variants.ts";
import { stepQty } from "./controls.tsx";

describe("stepQty", () => {
  test("up and down by one share, never below one", () => {
    expect(stepQty("5", 1)).toBe(6);
    expect(stepQty("5", -1)).toBe(4);
    expect(stepQty("1", -1)).toBe(1);
    expect(stepQty("1,000", 1)).toBe(1001);
  });

  test("by lots, landing on a lot", () => {
    expect(stepQty("10", 1, 10)).toBe(20);
    expect(stepQty("15", 1, 10)).toBe(20);
    expect(stepQty("15", -1, 10)).toBe(10);
    expect(stepQty("10", -1, 10)).toBe(10);
  });

  test("anything not a whole number starts again from one step", () => {
    for (const text of ["", "abc", "1.5", "-3", "0"]) expect(stepQty(text, 1, 10)).toBe(10);
  });
});

test("each style has a variant for every section that has them", () => {
  for (const style of STYLES) {
    expect(["form", "quick", "simple"]).toContain(VARIANTS[style].ticket);
    expect(["table", "list"]).toContain(VARIANTS[style].positions);
  }
});
