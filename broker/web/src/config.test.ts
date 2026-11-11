import { describe, expect, test } from "vitest";

import { configFrom } from "./config.ts";

describe("config", () => {
  test("defaults to the services' local ports", () => {
    expect(configFrom({})).toEqual({
      backendUrl: "http://localhost:8080",
      marketDataUrl: "http://localhost:8081",
      liveUrl: "ws://localhost:8081/live",
    });
  });

  test("uses what the build was given, and derives a secure socket from https", () => {
    const config = configFrom({
      VITE_BACKEND_URL: "https://api.example.com/",
      VITE_MARKET_DATA_URL: "https://md.example.com",
    });
    expect(config.backendUrl).toBe("https://api.example.com");
    expect(config.liveUrl).toBe("wss://md.example.com/live");
  });
});
