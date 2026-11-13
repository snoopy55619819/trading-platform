// One symbol's book, rebuilt from the public feed alone, with gap detection.
//
// The rules come from the venue's spec (vendor/exchange-alpha/marketdata.proto):
//   1. Nothing counts until a Snapshot: it sets the book and symbol_seq.
//   2. symbol_seq at or below ours is old news, already in the snapshot: ignore it.
//   3. symbol_seq + 1 is applied.
//   4. Anything further ahead means lost data. The book is stale until a fresh Snapshot.
//
// Prices and quantities arrive as int64 (bigint); they are converted to number here, once.
// Cents and share counts are far inside the range a number holds exactly.

import type { FeedMessage } from "../../gen/marketdata_pb.js";

const BUY = 1; // Side.BUY in the published schema

export type Applied =
  | { kind: "snapshot" }
  | { kind: "applied" }
  /** `buyerAggressed`: the buyer took liquidity (the aggressor); false when the seller did. */
  | { kind: "trade"; priceCents: number; qty: number; buyerAggressed: boolean }
  | { kind: "gap"; expected: bigint; received: bigint }
  | { kind: "ignored" };

export class Mirror {
  readonly symbol: string;
  /** price in cents -> quantity */
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private seq: bigint | undefined;
  lastTradeCents: number | undefined;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  /** False until a snapshot arrives, and again after a gap. */
  isLive(): boolean {
    return this.seq !== undefined;
  }

  bestBid(): number | undefined {
    return this.isLive() && this.bids.size > 0 ? Math.max(...this.bids.keys()) : undefined;
  }

  bestAsk(): number | undefined {
    return this.isLive() && this.asks.size > 0 ? Math.min(...this.asks.keys()) : undefined;
  }

  /** Midpoint in cents (may be a half cent), if both sides have orders. */
  mid(): number | undefined {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined;
  }

  apply(message: FeedMessage): Applied {
    const payload = message.payload;
    switch (payload.case) {
      case "snapshot": {
        if (payload.value.symbol !== this.symbol) return { kind: "ignored" };
        this.bids.clear();
        this.asks.clear();
        for (const level of payload.value.bids) this.bids.set(Number(level.priceCents), Number(level.qty));
        for (const level of payload.value.asks) this.asks.set(Number(level.priceCents), Number(level.qty));
        this.seq = payload.value.symbolSeq;
        return { kind: "snapshot" };
      }
      case "bookDelta": {
        const delta = payload.value;
        if (delta.symbol !== this.symbol) return { kind: "ignored" };
        const step = this.sequence(delta.symbolSeq);
        if (step.kind !== "applied") return step;
        const side = delta.side === BUY ? this.bids : this.asks;
        const price = Number(delta.priceCents);
        if (delta.qty === 0n) side.delete(price);
        else side.set(price, Number(delta.qty));
        return step;
      }
      case "tradePrint": {
        const trade = payload.value;
        if (trade.symbol !== this.symbol) return { kind: "ignored" };
        const step = this.sequence(trade.symbolSeq);
        if (step.kind !== "applied") return step;
        this.lastTradeCents = Number(trade.priceCents);
        return {
          kind: "trade",
          priceCents: this.lastTradeCents,
          qty: Number(trade.qty),
          buyerAggressed: trade.aggressorSide === BUY,
        };
      }
      default:
        return { kind: "ignored" };
    }
  }

  private sequence(received: bigint): Applied {
    if (this.seq === undefined || received <= this.seq) return { kind: "ignored" };
    if (received === this.seq + 1n) {
      this.seq = received;
      return { kind: "applied" };
    }
    const expected = this.seq + 1n;
    this.seq = undefined;
    return { kind: "gap", expected, received };
  }
}
