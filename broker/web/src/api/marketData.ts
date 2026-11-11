// broker market-data: chart history over HTTP, live books and trades over WebSocket.
// Public data, so no session is involved.

import { config } from "../config.ts";

export const INTERVALS = ["1m", "5m", "1h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];
export const INTERVAL_SECONDS: Record<Interval, number> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86_400 };

export interface Bar {
  /** Start of the bucket, ISO. */
  t: string;
  openCents: number;
  highCents: number;
  lowCents: number;
  closeCents: number;
  volume: number;
  trades: number;
}

export interface Level {
  priceCents: number;
  qty: number;
  orders: number;
}

export interface BookMessage {
  type: "book";
  symbol: string;
  /** False while the service cannot vouch for it (before its snapshot, after a gap). */
  live: boolean;
  bids: Level[];
  asks: Level[];
}

export interface TradeMessage {
  type: "trade";
  symbol: string;
  priceCents: number;
  qty: number;
  aggressor: "BUY" | "SELL";
  ts: string;
  tradeId: string;
}

export type LiveMessage = BookMessage | TradeMessage;

/** The most bars the service returns at once; ask for a wider interval to see further back. */
export const MAX_BARS = 1000;

export async function fetchHistory(symbol: string, interval: Interval, bars = 300, now = Date.now()): Promise<Bar[]> {
  const span = Math.min(bars, MAX_BARS) * INTERVAL_SECONDS[interval] * 1000;
  // Up to the end of the current bucket, so the bar still forming is included.
  const to = new Date(now + INTERVAL_SECONDS[interval] * 1000);
  const from = new Date(to.getTime() - span);
  const query = new URLSearchParams({ symbol, interval, from: from.toISOString(), to: to.toISOString() });
  const response = await fetch(`${config.marketDataUrl}/history?${query}`);
  const body = (await response.json()) as { bars?: Bar[]; text?: string };
  if (!response.ok || !body.bars) throw new Error(body.text ?? `history: HTTP ${response.status}`);
  return body.bars;
}

export type ConnectionState = "connecting" | "open" | "closed";

/**
 * One WebSocket to /live for the whole app. Remembers which symbols are wanted, sends the
 * subscription on every (re)connect, and reconnects with backoff when the line drops.
 * The socket factory is injectable so tests can drive it without a server.
 */
export class LiveFeed {
  private readonly url: string;
  private readonly onMessage: (message: LiveMessage) => void;
  private readonly onState: (state: ConnectionState) => void;
  private readonly createSocket: (url: string) => WebSocket;
  private socket: WebSocket | undefined;
  private readonly wanted = new Set<string>();
  private backoffMs = 1000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(options: {
    url?: string;
    onMessage: (message: LiveMessage) => void;
    onState?: (state: ConnectionState) => void;
    createSocket?: (url: string) => WebSocket;
  }) {
    this.url = options.url ?? config.liveUrl;
    this.onMessage = options.onMessage;
    this.onState = options.onState ?? (() => {});
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.socket = undefined;
  }

  subscribe(symbol: string): void {
    if (this.wanted.has(symbol)) return;
    this.wanted.add(symbol);
    this.send({ subscribe: [symbol] });
  }

  unsubscribe(symbol: string): void {
    if (!this.wanted.delete(symbol)) return;
    this.send({ unsubscribe: [symbol] });
  }

  private connect(): void {
    this.onState("connecting");
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.backoffMs = 1000;
      this.onState("open");
      if (this.wanted.size > 0) this.send({ subscribe: [...this.wanted] });
    };
    socket.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(String(event.data)) as LiveMessage);
      } catch {
        // not JSON: ignore it rather than take the feed down
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.onState("closed");
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }

  private send(message: object): void {
    // Sent now if connected; otherwise the next open sends the whole wanted set.
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
