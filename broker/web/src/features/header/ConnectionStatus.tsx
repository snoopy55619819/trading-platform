// Whether each connection the screen depends on is up: the backend, its link to the
// exchange, and live prices. Dead connections should be visible before an order fails.

import { useFeedState } from "../../market/hooks.ts";
import { useStatus } from "../../query/hooks.ts";

export type Health = "ok" | "waiting" | "bad";

export interface Connections {
  backend: Health;
  exchange: Health;
  prices: Health;
}

/** The state of each connection. Also watched for toasts when one drops. */
export function useConnections(): Connections {
  const status = useStatus();
  const feed = useFeedState();
  const backend: Health = status.isError ? "bad" : status.data ? "ok" : "waiting";
  const exchange: Health = !status.data ? (status.isError ? "bad" : "waiting") : status.data.connected ? "ok" : "bad";
  const prices: Health = feed === "open" ? "ok" : feed === "connecting" ? "waiting" : "bad";
  return { backend, exchange, prices };
}

export function ConnectionStatus() {
  return <ConnectionView connections={useConnections()} />;
}

const LABELS: Record<keyof Connections, string> = { backend: "Broker", exchange: "Exchange", prices: "Prices" };
const STATES: Record<Health, string> = { ok: "connected", waiting: "connecting", bad: "down" };

export function ConnectionView({ connections }: { connections: Connections }) {
  return (
    <ul className="connections" aria-label="Connections">
      {(Object.keys(LABELS) as (keyof Connections)[]).map((key) => (
        <li key={key} title={`${LABELS[key]}: ${STATES[connections[key]]}`}>
          <span className={`dot ${connections[key]}`} aria-hidden="true" />
          <span className="connection-label">{LABELS[key]}</span>
          <span className="sr-only">{STATES[connections[key]]}</span>
        </li>
      ))}
    </ul>
  );
}
