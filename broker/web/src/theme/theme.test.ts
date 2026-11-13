import { describe, expect, test } from "vitest";

import { parseSaved, resolveMode } from "./theme.ts";

describe("theme settings", () => {
  test("saved settings are read back; anything unknown or corrupt is the default", () => {
    expect(parseSaved(JSON.stringify({ modeChoice: "dark", style: "calm" }))).toEqual({ modeChoice: "dark", style: "calm" });
    expect(parseSaved(JSON.stringify({ modeChoice: "purple", style: "webull" }))).toEqual({ modeChoice: "system", style: "terminal" });
    expect(parseSaved("{not json")).toEqual({ modeChoice: "system", style: "terminal" });
    expect(parseSaved(null)).toEqual({ modeChoice: "system", style: "terminal" });
  });

  test("the mode follows the system until one is chosen", () => {
    expect(resolveMode("system", true, "pro")).toBe("dark");
    expect(resolveMode("system", false, "pro")).toBe("light");
    expect(resolveMode("light", true, "pro")).toBe("light");
    expect(resolveMode("dark", false, "pro")).toBe("dark");
  });

  test("Terminal is always dark, and keeps the choice for when another style is picked", () => {
    expect(parseSaved(JSON.stringify({ modeChoice: "light", style: "terminal" }))).toEqual({ modeChoice: "light", style: "terminal" });
    for (const choice of ["system", "light", "dark"] as const) {
      expect(resolveMode(choice, false, "terminal")).toBe("dark");
    }
  });
});
