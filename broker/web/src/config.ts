// Where the two services are. Read at build time from Vite's environment (VITE_*), so a
// deployed bundle points wherever it was built for; locally, the defaults are the
// services' own default ports.
//
//   VITE_BACKEND_URL       the broker backend's API   (default http://localhost:8080)
//   VITE_MARKET_DATA_URL   broker market-data         (default http://localhost:8081)
//
// Either may be a path on the page's own host instead (`/api`, `/md`), which is how the
// deployed image is built: one image then works on any hostname, behind a proxy that
// routes those paths.

export interface Config {
  backendUrl: string;
  marketDataUrl: string;
  /** market-data's live WebSocket, derived from its HTTP address. */
  liveUrl: string;
}

/** `pageOrigin` resolves path-only URLs; it is the page's own origin in the browser. */
export function configFrom(env: Record<string, string | undefined>, pageOrigin = "http://localhost"): Config {
  const backendUrl = trimSlash(env.VITE_BACKEND_URL || "http://localhost:8080");
  const marketDataUrl = trimSlash(env.VITE_MARKET_DATA_URL || "http://localhost:8081");
  // A socket needs a full address: a path is taken as on the page's own host.
  const absolute = marketDataUrl.startsWith("/") ? `${pageOrigin}${marketDataUrl}` : marketDataUrl;
  return {
    backendUrl,
    marketDataUrl,
    liveUrl: `${absolute.replace(/^http/, "ws")}/live`,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const config: Config = configFrom(import.meta.env, globalThis.location?.origin);
