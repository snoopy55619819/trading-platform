// What is typed into the order ticket, kept outside the ticket so other sections can fill it
// in: clicking a level in the order book sets a limit price. UI state, like the selected
// symbol, read through useSyncExternalStore. Not saved: a reload starts a fresh ticket.

import { useSyncExternalStore } from "react";

import type { OrderType, Side, TimeInForce } from "../../api/backend.ts";
import { formatCents } from "../../money.ts";
import { settingsStore } from "../../settings.ts";

export interface Draft {
  side: Side;
  orderType: OrderType;
  /** As typed. Parsed and checked by checkTicket. */
  qtyText: string;
  priceText: string;
  timeInForce: TimeInForce;
}

const initial: Draft = {
  side: "BUY",
  orderType: "MARKET",
  qtyText: String(settingsStore.get().defaultQty),
  priceText: "",
  timeInForce: "DAY",
};

let current = initial;
const listeners = new Set<() => void>();

export function updateDraft(change: Partial<Draft>): void {
  current = { ...current, ...change };
  for (const listener of listeners) listener();
}

// A new default quantity (Settings) goes straight onto the ticket.
let defaultQty = settingsStore.get().defaultQty;
settingsStore.subscribe(() => {
  const next = settingsStore.get().defaultQty;
  if (next !== defaultQty) updateDraft({ qtyText: String(next) });
  defaultQty = next;
});

export function useDraft(): Draft {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** From the order book: trade at this price, as a limit order. The side is left alone. */
export function useBookPrice(): (priceCents: number) => void {
  return (priceCents) => updateDraft({ orderType: "LIMIT", priceText: formatCents(priceCents, { grouping: false }) });
}
