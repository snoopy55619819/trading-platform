// Where the two services are. Read at build time from Vite's environment (VITE_*), so a
// deployed bundle points wherever it was built for; locally, the defaults are the
// services' own default ports.
//
//   VITE_BACKEND_URL       the broker backend's API   (default http://localhost:8080)
//   VITE_MARKET_DATA_URL   broker market-data         (default http://localhost:8081)

export interface Config {
  backendUrl: string;
  marketDataUrl: string;
  /** market-data's live WebSocket, derived from its HTTP address. */
  liveUrl: string;
}

export function configFrom(env: Record<string, string | undefined>): Config {
  const backendUrl = trimSlash(env.VITE_BACKEND_URL || "http://localhost:8080");
  const marketDataUrl = trimSlash(env.VITE_MARKET_DATA_URL || "http://localhost:8081");
  return {
    backendUrl,
    marketDataUrl,
    liveUrl: `${marketDataUrl.replace(/^http/, "ws")}/live`,
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export const config: Config = configFrom(import.meta.env);
