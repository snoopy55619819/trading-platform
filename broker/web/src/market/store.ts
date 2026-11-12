// The central market data store: what the live feed has said about each symbol, read by
// components through useSyncExternalStore.
//
// Each symbol's state is an immutable snapshot, replaced (never mutated) on every update.
// That is what React needs: getSnapshot returns the same object until something changed,
// and a component re-renders only for the symbols it reads.
//
// It also counts interest: the first component to want a symbol subscribes the feed to
// it, and the last to stop wanting it unsubscribes.

import type { BookMessage, TradeMessage } from "../api/marketData.ts";

/** Trades kept per symbol, and fetched for time and sales: enough for its largest choice. */
export const RECENT_TRADES = 50;

export interface SymbolMarket {
  book: BookMessage | undefined;
  /** Newest first, at most RECENT_TRADES. */
  trades: TradeMessage[];
  lastPriceCents: number | undefined;
}

const EMPTY: SymbolMarket = Object.freeze({ book: undefined, trades: [], lastPriceCents: undefined }) as SymbolMarket;

export interface FeedControl {
  subscribe(symbol: string): void;
  unsubscribe(symbol: string): void;
}

type Listener = () => void;

export class MarketStore {
  private readonly state = new Map<string, SymbolMarket>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly interest = new Map<string, number>();
  private feed: FeedControl | undefined;

  /** Connects the store to the feed it should subscribe on others' behalf. */
  attach(feed: FeedControl): void {
    this.feed = feed;
    for (const symbol of this.interest.keys()) feed.subscribe(symbol);
  }

  get(symbol: string): SymbolMarket {
    return this.state.get(symbol) ?? EMPTY;
  }

  /** For useSyncExternalStore: notified only when this symbol changes. */
  subscribe(symbol: string, listener: Listener): () => void {
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** A component wants live data for `symbol`. Returns the function to stop wanting it. */
  want(symbol: string): () => void {
    const count = this.interest.get(symbol) ?? 0;
    this.interest.set(symbol, count + 1);
    if (count === 0) this.feed?.subscribe(symbol);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.interest.get(symbol) ?? 1) - 1;
      if (remaining > 0) {
        this.interest.set(symbol, remaining);
        return;
      }
      this.interest.delete(symbol);
      this.feed?.unsubscribe(symbol);
    };
  }

  apply(message: BookMessage | TradeMessage): void {
    const before = this.get(message.symbol);
    const after: SymbolMarket =
      message.type === "book"
        ? { ...before, book: message }
        : {
            ...before,
            trades: [message, ...before.trades].slice(0, RECENT_TRADES),
            lastPriceCents: message.priceCents,
          };
    this.state.set(message.symbol, after);
    for (const listener of this.listeners.get(message.symbol) ?? []) listener();
  }

  /** The feed dropped: every book is stale until its new snapshot arrives. */
  markAllStale(): void {
    for (const [symbol, market] of this.state) {
      if (!market.book?.live) continue;
      this.state.set(symbol, { ...market, book: { ...market.book, live: false } });
      for (const listener of this.listeners.get(symbol) ?? []) listener();
    }
  }
}
