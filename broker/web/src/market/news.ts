// News from the newswire, as the web sees it (ADR 0006): the headlines market-data had stored
// before we connected, joined with the ones pushed live since, and where each one landed on
// the chart. The joining and placing are pure, so they are tested directly.

import type { Bar, Interval, NewsMessage } from "../api/marketData.ts";
import { bucketStart } from "./candles.ts";

/** Live headlines kept: far more than a panel shows. */
export const LIVE_NEWS = 200;

/**
 * Both lists in any order; the result is newest first and at most `limit` long, for
 * `symbol` or every symbol. A headline in both (stored, and also pushed live) appears once:
 * ids are unique.
 */
export function mergeNews(
  live: readonly NewsMessage[],
  stored: readonly NewsMessage[],
  symbol: string | undefined,
  limit: number,
): NewsMessage[] {
  const seen = new Set<string>();
  const merged: NewsMessage[] = [];
  for (const headline of [...live, ...stored]) {
    if (seen.has(headline.id) || (symbol !== undefined && headline.symbol !== symbol)) continue;
    seen.add(headline.id);
    merged.push(headline);
  }
  return merged.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || (a.id < b.id ? 1 : -1)).slice(0, limit);
}

/** Headlines that landed on one bar of the chart, newest first. */
export interface BarNews {
  /** The bar's position in `bars`. */
  index: number;
  headlines: NewsMessage[];
}

/**
 * Which bar each headline landed on: the one whose bucket holds its time. Headlines before
 * the first bar or after the last are left off, since the chart cannot show them. Bars are
 * oldest first, as the chart draws them; the result is too.
 */
export function newsOnBars(bars: readonly Bar[], headlines: readonly NewsMessage[], interval: Interval): BarNews[] {
  const byStart = new Map(bars.map((bar, index) => [Date.parse(bar.t), index]));
  const found = new Map<number, NewsMessage[]>();
  for (const headline of headlines) {
    const index = byStart.get(bucketStart(Date.parse(headline.ts), interval));
    if (index === undefined) continue;
    found.set(index, [...(found.get(index) ?? []), headline]);
  }
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, list]) => ({ index, headlines: list.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)) }));
}

/** The tone a bar's news marker shows: the newest moving story's, else neutral. */
export function markerTone(headlines: readonly NewsMessage[]): NewsMessage["tone"] {
  return headlines.find((h) => h.tone !== "NEUTRAL")?.tone ?? "NEUTRAL";
}

type Listener = () => void;

/** Headlines pushed live since the app started, newest first. */
export class NewsStore {
  private headlines: NewsMessage[] = [];
  private readonly listeners = new Set<Listener>();

  get = (): readonly NewsMessage[] => this.headlines;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  add(headline: NewsMessage): void {
    if (this.headlines.some((h) => h.id === headline.id)) return;
    this.headlines = [headline, ...this.headlines].slice(0, LIVE_NEWS);
    for (const listener of this.listeners) listener();
  }
}
