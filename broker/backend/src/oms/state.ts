// The order state machine. Every status change goes through `transition`, which refuses
// any move not listed here; the database separately refuses any move out of a terminal
// status (migrations/0003_oms.sql), so a bug here cannot reopen a finished order.

import { OrdStatus, TERMINAL_STATUSES } from "../domain/index.ts";

const ALLOWED: Record<OrdStatus, readonly OrdStatus[]> = {
  PENDING_NEW: ["NEW", "PARTIALLY_FILLED", "FILLED", "PENDING_CANCEL", "CANCELED", "REJECTED", "EXPIRED"],
  NEW: ["PARTIALLY_FILLED", "FILLED", "PENDING_CANCEL", "CANCELED", "EXPIRED"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "PENDING_CANCEL", "CANCELED", "EXPIRED"],
  // A fill can arrive while a cancel is in flight; a refused cancel returns to working.
  PENDING_CANCEL: ["PENDING_CANCEL", "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED"],
  FILLED: [],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
};

export function isTerminal(status: OrdStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Working: may still trade at the exchange. */
export function isWorking(status: OrdStatus): boolean {
  return !isTerminal(status);
}

export function transition(from: OrdStatus, to: OrdStatus): OrdStatus {
  if (!ALLOWED[from].includes(to)) throw new Error(`order cannot go from ${from} to ${to}`);
  return to;
}

/** Where an order sits when nothing special is happening to it. */
export function workingStatus(filledQty: number): OrdStatus {
  return filledQty > 0 ? OrdStatus.PARTIALLY_FILLED : OrdStatus.NEW;
}
