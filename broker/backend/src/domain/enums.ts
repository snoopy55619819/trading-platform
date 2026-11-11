// The broker's shared vocabulary.
//
// These were protobuf enums while api/oms/ledger were separate services. They are one
// process now, so protobuf bought nothing - these never cross a wire. What DOES cross a
// wire is FIX, so each value carries its FIX tag value alongside it.
//
// Written as const objects rather than TypeScript `enum` deliberately: `enum` is not
// erasable, so Node cannot run it without a build step (see tsconfig erasableSyntaxOnly).

export const Side = { BUY: "BUY", SELL: "SELL" } as const;
export type Side = (typeof Side)[keyof typeof Side];

/** FIX Side(54) */
export const SIDE_FIX: Record<Side, string> = { BUY: "1", SELL: "2" };

export const OrderType = { LIMIT: "LIMIT", MARKET: "MARKET" } as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

/** FIX OrdType(40) */
export const ORDER_TYPE_FIX: Record<OrderType, string> = { MARKET: "1", LIMIT: "2" };

export const TimeInForce = {
  DAY: "DAY",
  GTC: "GTC",
  /** Immediate-or-cancel: fill what you can right now, cancel the rest. */
  IOC: "IOC",
  /** Fill-or-kill: fill the entire quantity immediately or nothing at all. */
  FOK: "FOK",
} as const;
export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];

/** FIX TimeInForce(59) */
export const TIF_FIX: Record<TimeInForce, string> = { DAY: "0", GTC: "1", IOC: "3", FOK: "4" };

/**
 * Order lifecycle. FILLED, CANCELED, REJECTED and EXPIRED are terminal - no transition
 * leaves them.
 */
export const OrdStatus = {
  PENDING_NEW: "PENDING_NEW",
  NEW: "NEW",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  FILLED: "FILLED",
  PENDING_CANCEL: "PENDING_CANCEL",
  CANCELED: "CANCELED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
} as const;
export type OrdStatus = (typeof OrdStatus)[keyof typeof OrdStatus];

export const TERMINAL_STATUSES: readonly OrdStatus[] = [
  OrdStatus.FILLED, OrdStatus.CANCELED, OrdStatus.REJECTED, OrdStatus.EXPIRED,
];

/** FIX OrdStatus(39) */
export const ORD_STATUS_FIX: Record<OrdStatus, string> = {
  NEW: "0", PARTIALLY_FILLED: "1", FILLED: "2", CANCELED: "4",
  PENDING_CANCEL: "6", REJECTED: "8", PENDING_NEW: "A", EXPIRED: "C",
};

/** Why an execution report was emitted. Mirrors FIX ExecType(150). */
export const ExecType = {
  NEW: "NEW",
  TRADE: "TRADE",
  CANCELED: "CANCELED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
} as const;
export type ExecType = (typeof ExecType)[keyof typeof ExecType];

/** FIX ExecType(150) */
export const EXEC_TYPE_FIX: Record<ExecType, string> = {
  NEW: "0", CANCELED: "4", REJECTED: "8", EXPIRED: "C", TRADE: "F",
};

/**
 * Every rejection must name a reason. "Rejected" with no reason is a bug - the OMS
 * milestone's done-test is that bad orders are rejected for the RIGHT reason.
 */
export const RejectReason = {
  UNKNOWN_SYMBOL: "UNKNOWN_SYMBOL",
  SYMBOL_HALTED: "SYMBOL_HALTED",
  INVALID_TICK_SIZE: "INVALID_TICK_SIZE",
  INVALID_LOT_SIZE: "INVALID_LOT_SIZE",
  PRICE_OUT_OF_BAND: "PRICE_OUT_OF_BAND",
  INSUFFICIENT_BUYING_POWER: "INSUFFICIENT_BUYING_POWER",
  POSITION_LIMIT_EXCEEDED: "POSITION_LIMIT_EXCEEDED",
  /** A sell for more shares than the account holds, less what its working sells already commit. */
  INSUFFICIENT_POSITION: "INSUFFICIENT_POSITION",
  ORDER_VALUE_LIMIT_EXCEEDED: "ORDER_VALUE_LIMIT_EXCEEDED",
  DUPLICATE_CLIENT_ORDER_ID: "DUPLICATE_CLIENT_ORDER_ID",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  UNKNOWN_ACCOUNT: "UNKNOWN_ACCOUNT",
  UNKNOWN_ORDER: "UNKNOWN_ORDER",
  TOO_LATE_TO_CANCEL: "TOO_LATE_TO_CANCEL",
  MALFORMED_REQUEST: "MALFORMED_REQUEST",
  VENUE_UNAVAILABLE: "VENUE_UNAVAILABLE",
  /** The exchange refused it after our checks passed. Its own reason is in the reject text. */
  EXCHANGE_REJECTED: "EXCHANGE_REJECTED",
} as const;
export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason];

/** Ledger account types. Shares and cash are different assets and balance separately. */
export const AccountType = {
  CLIENT_CASH: "CLIENT_CASH",
  CLIENT_SECURITIES_UNSETTLED: "CLIENT_SECURITIES_UNSETTLED",
  CLIENT_SECURITIES_SETTLED: "CLIENT_SECURITIES_SETTLED",
  FEES_REVENUE: "FEES_REVENUE",
  HOUSE_CASH: "HOUSE_CASH",
  /** Market-facing contra. Becomes CLEARING_RECEIVABLE / _PAYABLE when the CCP arrives. */
  STREET_CONTRA: "STREET_CONTRA",
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];
