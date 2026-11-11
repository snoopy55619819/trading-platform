// The FIX tags and message types the broker uses, by their names in the venue's published
// dictionary (vendor/exchange-alpha/fix44.xml). test/fix.test.ts checks each against it.

export const Tag = {
  BeginString: 8, BodyLength: 9, CheckSum: 10, MsgSeqNum: 34, MsgType: 35,
  SenderCompID: 49, TargetCompID: 56, SendingTime: 52, PossDupFlag: 43, OrigSendingTime: 122,
  EncryptMethod: 98, HeartBtInt: 108, ResetSeqNumFlag: 141, TestReqID: 112,
  BeginSeqNo: 7, EndSeqNo: 16, NewSeqNo: 36, GapFillFlag: 123, Text: 58,
  ClOrdID: 11, OrigClOrdID: 41, OrderID: 37, ExecID: 17, Account: 1, Symbol: 55, Side: 54,
  TransactTime: 60, OrderQty: 38, OrdType: 40, Price: 44, TimeInForce: 59,
  ExecType: 150, OrdStatus: 39, LeavesQty: 151, CumQty: 14, LastQty: 32, LastPx: 31,
  Commission: 12, OrdRejReason: 103, CxlRejReason: 102,
} as const;

export const MsgType = {
  Heartbeat: "0", TestRequest: "1", ResendRequest: "2", Reject: "3", SequenceReset: "4",
  Logout: "5", Logon: "A", NewOrderSingle: "D", OrderCancelRequest: "F",
  ExecutionReport: "8", OrderCancelReject: "9",
} as const;

/** Session-level message types: never resent, always gap-filled. */
export const ADMIN_TYPES: ReadonlySet<string> = new Set(["0", "1", "2", "3", "4", "5", "A"]);
