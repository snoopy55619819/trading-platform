// The platform's live stats (ADR 0016): the latest sample, pushed once a second on /live,
// and the last five minutes for trend lines, seeded from GET /stats when first wanted.

import type { StatsMessage, StatsPoint } from "../api/marketData.ts";

/** Five minutes, one point a second. */
export const HISTORY = 300;

export interface StatsState {
  latest: StatsMessage | null;
  history: StatsPoint[];
}

export function pointOf(sample: StatsMessage): StatsPoint {
  return {
    ts: sample.ts,
    transactionsPerSec: sample.venue?.transactionsPerSec ?? null,
    tradesPerSec: sample.venue?.tradesPerSec ?? null,
    answerP99Us: sample.venue?.answerP99Us ?? null,
    liveMessagesOutPerSec: sample.marketData.liveMessagesOutPerSec,
  };
}

/** Joins a seeded history with the live points, by time, oldest first, the last HISTORY. */
export function mergeHistory(seeded: readonly StatsPoint[], live: readonly StatsPoint[]): StatsPoint[] {
  const byTs = new Map<string, StatsPoint>();
  for (const point of [...seeded, ...live]) byTs.set(point.ts, point);
  return [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-HISTORY);
}

/**
 * The average of the last `seconds` points' `key`, skipping seconds the exchange was silent:
 * per-second figures jump too much to read, so the header shows this.
 */
export function recentAverage(history: readonly StatsPoint[], key: "transactionsPerSec" | "tradesPerSec", seconds = 5): number | null {
  const values = history
    .slice(-seconds)
    .map((p) => p[key])
    .filter((v): v is number => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export class StatsStore {
  private state: StatsState = { latest: null, history: [] };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): StatsState => this.state;

  /** A sample pushed on /live. */
  add(sample: StatsMessage): void {
    this.set({ latest: sample, history: mergeHistory(this.state.history, [pointOf(sample)]) });
  }

  /** What GET /stats returned: kept unless something newer has already arrived live. */
  seed(latest: StatsMessage | null, history: readonly StatsPoint[]): void {
    const newer = this.state.latest && latest && this.state.latest.ts > latest.ts ? this.state.latest : latest;
    this.set({ latest: newer ?? this.state.latest, history: mergeHistory(history, this.state.history) });
  }

  private set(next: StatsState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
