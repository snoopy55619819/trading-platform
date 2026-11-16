// Time and sales flashes only trades that just arrived (features/tape/fresh.ts).

import { describe, expect, test } from "vitest";

import { arrivedAbove } from "./tape/fresh.ts";

const list = (...ids: string[]) => ids.map((tradeId) => ({ tradeId }));

describe("which trades just arrived", () => {
  test("the ones above last time's top row", () => {
    expect(arrivedAbove(list("t5", "t4", "t3"), "t3")).toEqual(["t5", "t4"]);
  });
  test("none on the first load", () => {
    expect(arrivedAbove(list("t2", "t1"), undefined)).toEqual([]);
  });
  test("none when nothing new came", () => {
    expect(arrivedAbove(list("t2", "t1"), "t2")).toEqual([]);
  });
  test("none after a change of symbol: last time's top is not in the list", () => {
    expect(arrivedAbove(list("a2", "a1"), "t9")).toEqual([]);
  });
  test("older trades filled in below the top are not new", () => {
    expect(arrivedAbove(list("t9", "t8", "t7", "t6"), "t9")).toEqual([]);
  });
});
