// The scaffold's placeholder: proves the build runs and that both services are reachable
// from the browser at the configured addresses (CORS included). Replaced by the real app
// shell in step 5.

import { useEffect, useState } from "react";

import { config } from "./config.ts";

type Check = "checking" | "reachable" | "unreachable";

function useReachable(url: string): Check {
  const [state, setState] = useState<Check>("checking");
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((response) => setState(response.ok ? "reachable" : "unreachable"))
      .catch(() => {
        if (!controller.signal.aborted) setState("unreachable");
      });
    return () => controller.abort();
  }, [url]);
  return state;
}

export function App() {
  const backend = useReachable(`${config.backendUrl}/status`);
  const marketData = useReachable(`${config.marketDataUrl}/health`);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h1>Broker</h1>
      <ul>
        <li>
          backend ({config.backendUrl}): <strong>{backend}</strong>
        </li>
        <li>
          market data ({config.marketDataUrl}): <strong>{marketData}</strong>
        </li>
      </ul>
    </main>
  );
}
