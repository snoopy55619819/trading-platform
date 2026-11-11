import { describe, expect, test } from "vitest";

import { changeBps, formatBps, formatCents, formatDollars, formatSignedDollars, parseDollars } from "./money.ts";

describe("money", () => {
  test("cents to text, exactly", () => {
    expect(formatCents(421_500)).toBe("4,215.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(-51)).toBe("-0.51");
    expect(formatCents(123_456_789, { grouping: false })).toBe("1234567.89");
    expect(formatDollars(-51)).toBe("-$0.51");
    expect(formatSignedDollars(126)).toBe("+$1.26");
    expect(formatSignedDollars(0)).toBe("$0.00");
  });

  test("what someone typed, to cents, with no float in between", () => {
    expect(parseDollars("42.1")).toBe(4210);
    expect(parseDollars("42.10")).toBe(4210);
    expect(parseDollars("42.")).toBe(4200);
    expect(parseDollars(" $1,000 ")).toBe(100_000);
    expect(parseDollars("0.29")).toBe(29); // 0.29 * 100 is 28.999... in floating point
    expect(parseDollars("1.005")).toBeUndefined(); // refused, not rounded
    expect(parseDollars("-1")).toBeUndefined();
    expect(parseDollars("1e3")).toBeUndefined();
    expect(parseDollars("")).toBeUndefined();
  });

  test("percentage change in basis points", () => {
    expect(changeBps(4250, 4200)).toBe(119);
    expect(formatBps(119)).toBe("+1.19%");
    expect(formatBps(-5)).toBe("-0.05%");
    expect(changeBps(1, 0)).toBeUndefined();
  });
});
