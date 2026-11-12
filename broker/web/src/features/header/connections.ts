// What the header's connection details say: a few plain lines per connection, built from
// what the web client already knows. Pure, so it is tested without a browser.

import type { ConnectionState } from "../../api/marketData.ts";

export interface ConnectionFacts {
  backend: {
    /** Undefined until the first check has answered or failed. */
    reachable: boolean | undefined;
    error?: string | undefined;
    /** When the last check answered or failed (ms since the epoch); 0 if none has yet. */
    checkedAt: number;
    everyMs: number;
  };
  exchange: {
    venue?: string | undefined;
    /** Undefined while the backend has not said (or cannot be reached). */
    connected: boolean | undefined;
    lastHeardAt?: number | undefined;
  };
  prices: {
    state: ConnectionState;
    since: number;
    lastMessageAt?: number | undefined;
  };
}

export interface Details {
  backend: string[];
  exchange: string[];
  prices: string[];
}

export function connectionDetails(facts: ConnectionFacts, now: number): Details {
  const { backend, exchange, prices } = facts;
  const every = `Checked every ${duration(backend.everyMs)}.`;
  const checked = backend.checkedAt ? `Last checked ${ago(now - backend.checkedAt)}.` : "Not checked yet.";
  const backendLines =
    backend.reachable === undefined
      ? ["Broker backend: checking.", every]
      : backend.reachable
        ? ["Broker backend: reachable.", checked, every]
        : [`Broker backend: not reachable${backend.error ? ` (${backend.error})` : ""}.`, checked, every];

  const venue = exchange.venue ?? "the exchange";
  const heard = exchange.lastHeardAt === undefined
    ? "Nothing heard from the exchange yet."
    : `Last message from the exchange ${ago(now - exchange.lastHeardAt)} (heartbeats included).`;
  const exchangeLines =
    exchange.connected === undefined
      ? [backend.reachable === false ? "Exchange: unknown, the broker backend cannot be reached." : "Exchange: checking."]
      : [`Exchange: FIX session to ${venue} ${exchange.connected ? "up" : "down"}.`, heard];

  const lastMessage = prices.lastMessageAt === undefined ? "No messages yet." : `Last message ${ago(now - prices.lastMessageAt)}.`;
  const pricesLines =
    prices.state === "open"
      ? [`Prices: live WebSocket connected for ${duration(now - prices.since)}.`, lastMessage]
      : prices.state === "connecting"
        ? ["Prices: live WebSocket connecting.", lastMessage]
        : [`Prices: live WebSocket down for ${duration(now - prices.since)}, retrying.`, lastMessage];

  return { backend: backendLines, exchange: exchangeLines, prices: pricesLines };
}

/** A rough length of time: "4s", "2m", "1h". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** "just now" under a second, otherwise "4s ago", "2m ago", "1h ago". */
export function ago(ms: number): string {
  return ms < 1000 ? "just now" : `${duration(ms)} ago`;
}
