import { describe, expect, test } from "vitest";

import { parseSaved, resolveMode } from "./theme.ts";

describe("theme settings", () => {
  test("saved settings are read back; anything unknown or corrupt is the default", () => {
    expect(parseSaved(JSON.stringify({ modeChoice: "dark", style: "calm" }))).toEqual({ modeChoice: "dark", style: "calm" });
    expect(parseSaved(JSON.stringify({ modeChoice: "purple", style: "webull" }))).toEqual({ modeChoice: "system", style: "active" });
    expect(parseSaved("{not json")).toEqual({ modeChoice: "system", style: "active" });
    expect(parseSaved(null)).toEqual({ modeChoice: "system", style: "active" });
  });

  test("the mode follows the system until one is chosen", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });
});
