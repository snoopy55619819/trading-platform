import { describe, expect, test } from "vitest";

import { DEFAULT_LAYOUTS, type Layout, validateLayout } from "./layouts.ts";

const pro: Layout = DEFAULT_LAYOUTS.pro;

describe("layouts", () => {
  test("every default layout is sound", () => {
    for (const [style, layout] of Object.entries(DEFAULT_LAYOUTS)) {
      expect(validateLayout(layout), style).toEqual([]);
    }
  });

  test("Calm has no order book or tape at all, rather than hiding them", () => {
    const types = DEFAULT_LAYOUTS.calm.panels.map((p) => p.type);
    expect(types).not.toContain("book");
    expect(types).not.toContain("tape");
  });

  test("overlaps, off-grid placements and missing panels are caught", () => {
    const moved = (id: string, change: object): Layout => ({
      ...pro,
      desktop: pro.desktop.map((p) => (p.id === id ? { ...p, ...change } : p)),
    });
    expect(validateLayout(moved("book", { x: 8 }))).toContain("book overlaps chart");
    expect(validateLayout(moved("tape", { w: 4 }))).toContain("tape does not fit the 12-column grid");
    expect(validateLayout(moved("tape", { h: 5 }))).toContain("tape does not fit the 12 rows");
    expect(validateLayout({ ...pro, desktop: pro.desktop.filter((p) => p.id !== "tape") })).toContain(
      "tape has no place on the desktop",
    );
  });

  test("two instances of one section are fine; a reused id is not", () => {
    const twoCharts: Layout = {
      ...pro,
      panels: [...pro.panels, { id: "chart-2", type: "chart", props: { symbol: "GRID" } }],
      desktop: [...pro.desktop.map((p) => (p.id === "chart" ? { ...p, h: 4 } : p)), { id: "chart-2", x: 2, y: 4, w: 7, h: 4 }],
    };
    expect(validateLayout(twoCharts)).toEqual([]);
    const clash: Layout = { ...pro, panels: [...pro.panels, { id: "chart", type: "chart" }] };
    expect(validateLayout(clash)).toContain("two panels are called chart");
  });
});
