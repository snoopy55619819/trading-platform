// React's view of market data: one live feed and one store for the whole app, and hooks
// that read them. Components never touch the WebSocket.

import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  type ConnectionState,
  DEFAULT_BARS,
  type Interval,
  LiveFeed,
  MAX_BARS,
  type NewsMessage,
  fetchHistory,
  fetchNews,
  fetchRecentTrades,
} from "../api/marketData.ts";
import { bucketStart, foldTrade } from "./candles.ts";
import { NewsStore, mergeNews } from "./news.ts";
import { MarketStore, RECENT_TRADES, type SymbolMarket } from "./store.ts";
import { mergeTrades } from "./tape.ts";
import { quoteFrom } from "../features/header/quote.ts";

export const marketStore = new MarketStore();
export const newsStore = new NewsStore();

// The feed's connection state, as a tiny store of its own.
let feedState: ConnectionState = "closed";
const feedStateListeners = new Set<() => void>();
// When the state last changed and when the last message arrived, for the header's
// connection details. Not reactive: the details re-read them on their own clock.
let feedSince = Date.now();
let feedLastMessageAt: number | undefined;
function setFeedState(next: ConnectionState): void {
  if (next !== feedState) feedSince = Date.now();
  feedState = next;
  if (next === "closed") marketStore.markAllStale();
  for (const listener of feedStateListeners) listener();
}

let feed: LiveFeed | undefined;

/** Opens the live feed. Called once, at startup. */
export function startMarketData(): void {
  if (feed) return;
  feed = new LiveFeed({
    onMessage: (message) => {
      feedLastMessageAt = Date.now();
      if (message.type === "news") newsStore.add(message);
      else marketStore.apply(message);
    },
    onState: setFeedState,
  });
  marketStore.attach(feed);
  feed.start();
}

export function useFeedState(): ConnectionState {
  return useSyncExternalStore(
    (listener) => {
      feedStateListeners.add(listener);
      return () => feedStateListeners.delete(listener);
    },
    () => feedState,
  );
}

/** When the feed's state last changed, and when its last message arrived (if any has). */
export function feedTimes(): { since: number; lastMessageAt: number | undefined } {
  return { since: feedSince, lastMessageAt: feedLastMessageAt };
}

/** Live book, recent trades and last price for one symbol. Subscribes while mounted. */
export function useMarket(symbol: string | undefined): SymbolMarket {
  useEffect(() => (symbol ? marketStore.want(symbol) : undefined), [symbol]);
  return useSyncExternalStore(
    (listener) => (symbol ? marketStore.subscribe(symbol, listener) : () => {}),
    () => marketStore.get(symbol ?? ""),
  );
}

/**
 * Chart bars: history from market-data, with live trades since that fetch folded into the
 * latest bars. History is refetched every minute, which also corrects anything the live
 * folding could not see (trades beyond the store's recent window).
 *
 * `count` is how many bars to ask for (at most MAX_BARS). Asking for more of the same
 * symbol and interval keeps showing the bars already there until the longer list arrives,
 * so widening the chart's range does not blank it.
 */
export function useHistory(symbol: string | undefined, interval: Interval, count = DEFAULT_BARS) {
  const bars = Math.min(count, MAX_BARS);
  const history = useQuery({
    queryKey: ["history", symbol, interval, bars],
    queryFn: () => fetchHistory(symbol!, interval, bars),
    enabled: symbol !== undefined,
    refetchInterval: 60_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === symbol && previousQuery?.queryKey[2] === interval ? previous : undefined,
  });
  const market = useMarket(symbol);
  const folded = useMemo(() => {
    if (!history.data) return undefined;
    // Placeholder bars were fetched at some earlier time we cannot see, so folding trades
    // in could count some twice. They show as fetched, briefly, until the real ones land.
    if (history.isPlaceholderData) return history.data;
    const fetchedAt = history.dataUpdatedAt;
    // Only trades after the fetch: anything earlier may already be in the bars, and
    // counting it twice would be wrong. A trade printed just before the fetch but not yet
    // rolled up by market-data is missed until the next refetch, which is the lesser error.
    // Trades are newest first; fold them oldest first.
    const since = market.trades.filter((t) => Date.parse(t.ts) > fetchedAt).reverse();
    return since.reduce((bars, trade) => foldTrade(bars, trade, interval), history.data);
  }, [history.data, history.dataUpdatedAt, history.isPlaceholderData, market.trades, interval]);
  return { bars: folded, isLoading: history.isLoading, isPlaceholderData: history.isPlaceholderData, error: history.error };
}

/**
 * Time and sales for one symbol: the stored trades from before we subscribed, then the live
 * ones as they print. The stored list is fetched when the symbol changes and every minute,
 * which also fills anything missed while the feed was down.
 */
export function useRecentTrades(symbol: string | undefined) {
  const stored = useQuery({
    queryKey: ["trades", symbol],
    queryFn: () => fetchRecentTrades(symbol!, RECENT_TRADES),
    enabled: symbol !== undefined,
    refetchInterval: 60_000,
  });
  const market = useMarket(symbol);
  const trades = useMemo(
    () => mergeTrades(market.trades, stored.data ?? [], RECENT_TRADES),
    [market.trades, stored.data],
  );
  return { trades, isLoading: stored.isLoading && market.trades.length === 0, error: stored.error };
}

/**
 * The latest headlines, newest first: for `symbol`, or every symbol's when it is undefined.
 * The stored ones are fetched when the choice changes and every minute (which also fills
 * anything missed while the feed was down); live ones are added as they arrive.
 */
export function useNews(symbol: string | undefined, limit = 50): { news: NewsMessage[]; isLoading: boolean; error: Error | null } {
  const stored = useQuery({
    queryKey: ["news", symbol ?? "*", limit],
    queryFn: () => fetchNews(symbol, limit),
    refetchInterval: 60_000,
  });
  const live = useSyncExternalStore(newsStore.subscribe, newsStore.get);
  const news = useMemo(() => mergeNews(live, stored.data ?? [], symbol, limit), [live, stored.data, symbol, limit]);
  return { news, isLoading: stored.isLoading && news.length === 0, error: stored.error };
}

/** Live data for several symbols at once (the same store, one subscription each). */
export function useMarkets(symbols: readonly string[]): SymbolMarket[] {
  const key = symbols.join(",");
  // Effects key on `key`, not the array: a new array with the same symbols changes nothing.
  useEffect(() => {
    const releases = symbols.map((s) => marketStore.want(s));
    return () => releases.forEach((release) => release());
  }, [key]);
  const cache = useRef<SymbolMarket[]>([]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = symbols.map((s) => marketStore.subscribe(s, listener));
      return () => offs.forEach((off) => off());
    },
    [key],
  );
  return useSyncExternalStore(subscribe, () => {
    // The same array until one of the symbols changes, as useSyncExternalStore requires.
    const next = symbols.map((s) => marketStore.get(s));
    const previous = cache.current;
    if (previous.length === next.length && previous.every((m, i) => m === next[i])) return previous;
    cache.current = next;
    return next;
  });
}

/**
 * The price each symbol is valued at: the live last trade, else the last stored trade (its
 * daily bar's close), else the previous close. The same rule as the quote in the top bar.
 */
export function useLastPrices(symbols: readonly string[]): Map<string, number | undefined> {
  const markets = useMarkets(symbols);
  const daily = useQueries({
    queries: symbols.map((symbol) => ({
      // The same key as a daily chart's default, so the two share one fetch.
      queryKey: ["history", symbol, "1d", DEFAULT_BARS],
      queryFn: () => fetchHistory(symbol, "1d", DEFAULT_BARS),
      refetchInterval: 60_000,
    })),
  });
  const todayStart = bucketStart(Date.now(), "1d");
  return new Map(symbols.map((symbol, i) => [symbol, quoteFrom(markets[i]!, daily[i]?.data, todayStart).lastCents]));
}
