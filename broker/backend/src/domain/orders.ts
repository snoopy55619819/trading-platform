// Orders and executions.
//
// Money and prices are integer cents; quantities are whole shares. Never floats -
// see CLAUDE.md. Field names carry their unit: a bare `price` or `amount` is a bug.

import type {
  ExecType, OrdStatus, OrderType, RejectReason, Side, TimeInForce,
} from "./enums.ts";

export interface Order {
  orderId: string;
  /**
   * Client-assigned idempotency key, unique per session per business date.
   * A duplicate is REJECTED, never executed twice.
   */
  clientOrderId: string;
  accountId: string;
  /** Always "ALPHA" in v1. Present so adding a venue is data, not a migration. */
  venue: string;
  symbol: string;

  side: Side;
  orderType: OrderType;
  timeInForce: TimeInForce;
  /** Absent for MARKET orders. Must be a multiple of the symbol's tickSizeCents. */
  priceCents?: number;
  qty: number;
  currency: string;

  status: OrdStatus;
  filledQty: number;
  /**
   * totalNotionalCents / filledQty, integer division. Lossy by construction - never
   * reconstruct notional from it, use totalNotionalCents.
   */
  avgFillPriceCents: number;
  totalNotionalCents: number;
  feeCents: number;

  rejectReason?: RejectReason;
  rejectText?: string;

  createdTsNs: bigint;
  updatedTsNs: bigint;
}

export interface PlaceOrder {
  accountId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  orderType: OrderType;
  timeInForce: TimeInForce;
  priceCents?: number;
  qty: number;
  currency: string;
}

export interface CancelOrder {
  accountId: string;
  orderId?: string;
  clientOrderId?: string;
  /** Idempotency key for the cancel request itself. */
  cancelClientOrderId: string;
}

/**
 * The PRIVATE result of a match. Goes to the order's owner and nobody else.
 *
 * Its public counterpart is the exchange's TradePrint, which has no field for an account
 * or a client order id. Leaking either onto the market data plane is a correctness bug.
 */
export interface ExecutionReport {
  execId: string;
  execType: ExecType;
  orderId: string;
  clientOrderId: string;
  accountId: string;
  venue: string;
  symbol: string;
  side: Side;
  ordStatus: OrdStatus;

  /** Set only when execType is TRADE. */
  lastQty?: number;
  lastPriceCents?: number;
  tradeId?: string;
  /**
   * True when this order took liquidity rather than resting. Decides whether the maker
   * rebate or the taker fee applies - without it the fee cannot be computed.
   */
  isAggressor?: boolean;

  cumQty: number;
  leavesQty: number;
  avgPriceCents: number;
  totalNotionalCents: number;
  feeCents: number;

  rejectReason?: RejectReason;
  rejectText?: string;
  currency: string;
  transactTsNs: bigint;
}

/** Emitted when an execution changes a position. One Fill = one balanced journal entry. */
export interface Fill {
  fillId: string;
  execId: string;
  tradeId: string;
  orderId: string;
  accountId: string;
  venue: string;
  symbol: string;
  side: Side;
  qty: number;
  priceCents: number;
  notionalCents: number;
  /** Negative for a maker rebate. The sign is preserved through the ledger. */
  feeCents: number;
  currency: string;
  transactTsNs: bigint;
  /**
   * The business date this fill belongs to. NOT derivable from transactTsNs - trading
   * days do not align to UTC midnight.
   */
  businessDate: string;
}
