// Ledger shapes.
//
// Positions and balances are DERIVED by summing journal lines - never stored as a
// running total that something increments.

import type { AccountType } from "./enums.ts";

export interface Position {
  accountId: string;
  symbol: string;
  /**
   * Tradeable immediately. v1 promotes unsettled to settled at once; post-MVP the same
   * job waits for T+1. Separate fields from day one so that change is timing, not schema.
   */
  qtySettled: number;
  qtyUnsettled: number;
  /** Exact accumulated cost. avgCostCents is derived from it, not the reverse. */
  totalCostCents: number;
  avgCostCents: number;
  currency: string;
}

export interface Balance {
  accountId: string;
  accountType: AccountType;
  /** 'CASH' or a ticker. Cash amounts are cents, share amounts are shares. */
  asset: string;
  amount: number;
  currency: string;
}

export interface BuyingPower {
  accountId: string;
  /** Settled cash less cash committed to working buy orders. */
  buyingPowerCents: number;
  cashBalanceCents: number;
  reservedCents: number;
  currency: string;
}

/** One side of a journal entry. Entries balance per asset, not across assets. */
export interface JournalLine {
  accountId: string;
  asset: string;
  debit: number;
  credit: number;
}
