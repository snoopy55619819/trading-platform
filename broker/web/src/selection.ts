// The symbol being looked at. UI state, shared by every section on the screen, and
// remembered for next time (a convenience only: it falls back to the first listed symbol).

import { useSyncExternalStore } from "react";

const KEY = "broker.symbol";
let current: string | undefined = read();
const listeners = new Set<() => void>();

function read(): string | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : (localStorage.getItem(KEY) ?? undefined);
  } catch {
    return undefined;
  }
}

export function selectSymbol(symbol: string): void {
  current = symbol;
  try {
    localStorage.setItem(KEY, symbol);
  } catch {
    // storage blocked: just not remembered
  }
  for (const listener of listeners) listener();
}

/** The selected symbol, or `fallback` if none was chosen (or it is no longer listed). */
export function useSelectedSymbol(listed: readonly string[], fallback: string | undefined): string | undefined {
  const chosen = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  return chosen && listed.includes(chosen) ? chosen : fallback;
}
