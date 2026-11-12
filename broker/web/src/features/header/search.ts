// Matching what someone types against the symbol list. Pure, so it is tested directly.
//
// Order: an exact ticker, then tickers starting with the query, then names containing it.
// So "a" finds ACME before anything with an "a" somewhere in its name.

import type { Security } from "../../api/backend.ts";

export function matchSymbols(query: string, symbols: readonly Security[], limit = 8): Security[] {
  const q = query.trim().toUpperCase();
  if (!q) return symbols.slice(0, limit);
  const rank = (s: Security): number => {
    if (s.symbol === q) return 0;
    if (s.symbol.startsWith(q)) return 1;
    if (s.name.toUpperCase().includes(q)) return 2;
    return -1;
  };
  return symbols
    .map((s) => ({ s, r: rank(s) }))
    .filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || a.s.symbol.localeCompare(b.s.symbol))
    .slice(0, limit)
    .map(({ s }) => s);
}

/** A key press, as much of it as matters here. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Whether a key pressed anywhere on the page should start a symbol search: a letter with no
 * shortcut key held (Shift is fine), while focus is not already in something typed into
 * and no dialog is open. Then the letter goes into the symbol box instead of nowhere.
 */
export function startsSearch(press: KeyPress, where: { editable: boolean; dialogOpen: boolean }): boolean {
  if (press.ctrlKey || press.metaKey || press.altKey) return false;
  if (where.editable || where.dialogOpen) return false;
  return /^[a-z]$/i.test(press.key);
}
