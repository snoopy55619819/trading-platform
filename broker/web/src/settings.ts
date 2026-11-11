// Trading preferences that are not about looks: for now, the ticket's default quantity.
// Saved in localStorage per browser, like the theme. (Mode and style live in theme.ts.)

import { useSyncExternalStore } from "react";

export interface Settings {
  /** Shares the ticket starts with. A positive whole number. */
  defaultQty: number;
}

const KEY = "broker.settings";
export const DEFAULT_SETTINGS: Settings = { defaultQty: 1 };

/** A saved value, checked: anything unreadable or out of range falls back to the default. */
export function parseSettings(raw: string | null): Settings {
  try {
    const saved = JSON.parse(raw ?? "{}") as Partial<Settings>;
    const qty = saved.defaultQty;
    return { defaultQty: typeof qty === "number" && Number.isSafeInteger(qty) && qty > 0 ? qty : DEFAULT_SETTINGS.defaultQty };
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
