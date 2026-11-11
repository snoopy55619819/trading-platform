// One symbol's order book, rebuilt from the venue's feed alone, with gap detection.
//
// The rules are the venue's (vendor/exchange-alpha/marketdata.proto), implemented here from
// the spec rather than borrowed from anyone else's client:
//   1. Nothing counts until a Snapshot: it sets the book and symbol_seq.
//   2. symbol_seq at or below ours is already in the snapshot: ignore it.
//   3. symbol_seq + 1 is applied.
//   4. Anything further ahead means lost messages. The book is stale until a fresh Snapshot.

import type { FeedMessage, TradePrint } from "../../gen/marketdata_pb.js";

const BUY = 1; // Side.BUY in the published schema

export type Applied =
  | { kind: "snapshot" }
  | { kind: "level" }
  | { kind: "trade"; trade: TradePrint }
  | { kind: "gap"; expected: bigint; received: bigint }
  | { kind: "ignored" };

export interface Level {
  priceCents: number;
  qty: number;
  orders: number;
}

export class Mirror {
  readonly symbol: string;
  private readonly bids = new Map<number, Level>();
  private readonly asks = new Map<number, Level>();
  private seq: bigint | undefined;
  /** Bumped on every change, so a publisher can tell whether there is anything new. */
  version = 0;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  isLive(): boolean {
    return this.seq !== undefined;
  }

  /** Best first, at most `depth` levels a side. Empty while stale. */
  book(depth: number): { bids: Level[]; asks: Level[] } {
    if (!this.isLive()) return { bids: [], asks: [] };
    return {
      bids: [...this.bids.values()].sort((a, b) => b.priceCents - a.priceCents).slice(0, depth),
      asks: [...this.asks.values()].sort((a, b) => a.priceCents - b.priceCents).slice(0, depth),
    };
  }

  apply(message: FeedMessage): Applied {
    const payload = message.payload;
    switch (payload.case) {
      case "snapshot": {
        const snapshot = payload.value;
        if (snapshot.symbol !== this.symbol) return { kind: "ignored" };
        this.bids.clear();
        this.asks.clear();
        for (const l of snapshot.bids) this.set(this.bids, Number(l.priceCents), Number(l.qty), l.orderCount);
        for (const l of snapshot.asks) this.set(this.asks, Number(l.priceCents), Number(l.qty), l.orderCount);
        this.seq = snapshot.symbolSeq;
        this.version += 1;
        return { kind: "snapshot" };
      }
      case "bookDelta": {
        const delta = payload.value;
        if (delta.symbol !== this.symbol) return { kind: "ignored" };
        const step = this.sequence(delta.symbolSeq);
        if (step) return step;
        this.set(delta.side === BUY ? this.bids : this.asks, Number(delta.priceCents), Number(delta.qty), delta.orderCount);
        this.version += 1;
        return { kind: "level" };
      }
      case "tradePrint": {
        const trade = payload.value;
        if (trade.symbol !== this.symbol) return { kind: "ignored" };
        return this.sequence(trade.symbolSeq) ?? { kind: "trade", trade };
      }
      default:
        return { kind: "ignored" };
    }
  }

  /** undefined if `received` is the next one (and records it); otherwise why not. */
  private sequence(received: bigint): Applied | undefined {
    if (this.seq === undefined || received <= this.seq) return { kind: "ignored" };
    if (received === this.seq + 1n) {
      this.seq = received;
      return undefined;
    }
    const expected = this.seq + 1n;
    this.seq = undefined;
    this.version += 1; // the book just went stale
    return { kind: "gap", expected, received };
  }

  private set(side: Map<number, Level>, priceCents: number, qty: number, orders: number): void {
    // Absolute quantities: qty 0 means the level is gone.
    if (qty === 0) side.delete(priceCents);
    else side.set(priceCents, { priceCents, qty, orders });
  }
}
