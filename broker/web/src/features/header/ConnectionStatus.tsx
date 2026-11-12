// Whether each connection the screen depends on is up: the backend, its link to the
// exchange, and live prices. Dead connections should be visible before an order fails.
// Hovering or focusing one shows its details: what it is, and when it was last heard from.

import { useEffect, useId, useState } from "react";

import { feedTimes, useFeedState } from "../../market/hooks.ts";
import { SLOW_POLL_MS, useStatus } from "../../query/hooks.ts";
import { type ConnectionFacts, type Details, connectionDetails } from "./connections.ts";

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

/** What is known about each connection, for its details. */
function useConnectionFacts(): ConnectionFacts {
  const status = useStatus();
  const feed = useFeedState();
  const times = feedTimes();
  const reachable = status.isError ? false : status.data ? true : undefined;
  const lastHeardAt = status.data?.lastHeardAt;
  return {
    backend: {
      reachable,
      error: status.error?.message,
      checkedAt: Math.max(status.dataUpdatedAt, status.errorUpdatedAt),
      everyMs: SLOW_POLL_MS,
    },
    exchange: {
      venue: status.data?.venue,
      // A failed check means the last answer is out of date, so say nothing about the exchange.
      connected: status.isError ? undefined : status.data?.connected,
      lastHeardAt: lastHeardAt ? Date.parse(lastHeardAt) : undefined,
    },
    prices: { state: feed, since: times.since, lastMessageAt: times.lastMessageAt },
  };
}

/** The time now, ticking every second while `active`, so "3s ago" stays true. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ConnectionStatus() {
  const [open, setOpen] = useState<keyof Connections>();
  const facts = useConnectionFacts();
  const now = useNow(open !== undefined);
  return <ConnectionView connections={useConnections()} details={connectionDetails(facts, now)} open={open} onOpen={setOpen} />;
}

const LABELS: Record<keyof Connections, string> = { backend: "Broker", exchange: "Exchange", prices: "Prices" };
const STATES: Record<Health, string> = { ok: "connected", waiting: "connecting", bad: "down" };

export function ConnectionView({
  connections,
  details,
  open,
  onOpen,
}: {
  connections: Connections;
  details: Details;
  /** The connection whose details are showing, if any. */
  open: keyof Connections | undefined;
  onOpen: (key: keyof Connections | undefined) => void;
}) {
  const id = useId();
  return (
    <ul className="connections" aria-label="Connections">
      {(Object.keys(LABELS) as (keyof Connections)[]).map((key) => (
        <li
          key={key}
          tabIndex={0}
          aria-describedby={open === key ? `${id}-${key}` : undefined}
          onMouseEnter={() => onOpen(key)}
          onMouseLeave={() => onOpen(undefined)}
          onFocus={() => onOpen(key)}
          onBlur={() => onOpen(undefined)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onOpen(undefined);
          }}
        >
          <span className={`dot ${connections[key]}`} aria-hidden="true" />
          <span className="connection-label">{LABELS[key]}</span>
          <span className="sr-only">{STATES[connections[key]]}</span>
          {open === key && (
            <div className="connection-details" role="tooltip" id={`${id}-${key}`}>
              {details[key].map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
