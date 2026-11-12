// Trading preferences that are not about looks: the ticket's default quantity, how many
// trades time and sales shows, and whether the news panel shows one symbol or all. Saved in localStorage per browser, like the theme. (Mode and
// style live in theme.ts.)

import { useSyncExternalStore } from "react";

/** The choices for time and sales. The store and the first fetch keep enough for the largest. */
export const TAPE_ROWS = [5, 10, 50] as const;
export type TapeRows = (typeof TAPE_ROWS)[number];

/** The news panel: the selected symbol's headlines, or every symbol's. */
export const NEWS_SCOPES = ["symbol", "all"] as const;
export type NewsScope = (typeof NEWS_SCOPES)[number];

export interface Settings {
  /** Shares the ticket starts with. A positive whole number. */
  defaultQty: number;
  /** How many of the latest trades time and sales shows. */
  tapeRows: TapeRows;
  newsScope: NewsScope;
}

const KEY = "broker.settings";
// Every symbol's news by default: there is a story somewhere every few minutes, but one
// company's can be an hour apart.
export const DEFAULT_SETTINGS: Settings = { defaultQty: 1, tapeRows: 50, newsScope: "all" };

/** A saved value, checked: anything unreadable or out of range falls back to the default. */
export function parseSettings(raw: string | null): Settings {
  try {
    const saved = JSON.parse(raw ?? "{}") as Partial<Settings>;
    const qty = saved.defaultQty;
    const rows = saved.tapeRows;
    return {
      defaultQty: typeof qty === "number" && Number.isSafeInteger(qty) && qty > 0 ? qty : DEFAULT_SETTINGS.defaultQty,
      tapeRows: TAPE_ROWS.includes(rows as TapeRows) ? (rows as TapeRows) : DEFAULT_SETTINGS.tapeRows,
      newsScope: NEWS_SCOPES.includes(saved.newsScope as NewsScope) ? (saved.newsScope as NewsScope) : DEFAULT_SETTINGS.newsScope,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function read(): Settings {
  try {
    return parseSettings(typeof localStorage === "undefined" ? null : localStorage.getItem(KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export const settingsStore = {
  get: (): Settings => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  update(change: Partial<Settings>): void {
    current = { ...current, ...change };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // storage blocked: kept for this visit only
    }
    for (const listener of listeners) listener();
  },
};

export function useSettings(): Settings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
}
