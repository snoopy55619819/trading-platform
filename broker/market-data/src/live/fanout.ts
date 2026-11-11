// Live prices for browsers, over WebSocket, as JSON. This is the broker's own protocol to
// its own web client, not the venue's: browsers never talk to the exchange.
//
//   client -> {"subscribe": ["ACME", "CRUX"]}   or   {"unsubscribe": ["ACME"]}
//   server -> {"type": "book",  "symbol", "live", "bids": [{priceCents, qty, orders}], "asks": [...]}
//             {"type": "trade", "symbol", "priceCents", "qty", "aggressor", "ts", "tradeId"}
//
// Books are CONFLATED: at most one per symbol every BOOK_INTERVAL_MS, always the latest. A
// browser needs the current state, not every intermediate one. Trades are sent as they
// happen, because each one is a point on the chart.
//
// Slow-client policy: ingest never waits for a browser. Sends are queued by the socket; a
// client whose queue passes MAX_BUFFERED_BYTES is disconnected, and reconnecting gets it
// the current books at once. Waiting for it would stall everyone; dropping messages
// quietly would leave it showing a stale book with no sign that it was stale.

import type { Server } from "node:http";

import { type WebSocket, WebSocketServer } from "ws";

import type { Mirror } from "../feed/mirror.ts";
import type { Tick } from "../store/ticks.ts";

const BOOK_INTERVAL_MS = 100;
const BOOK_DEPTH = 10;
const MAX_BUFFERED_BYTES = 1_000_000;
const MAX_SYMBOLS_PER_CLIENT = 50;

export class Fanout {
  private readonly server: WebSocketServer;
  private readonly subscribers = new Map<WebSocket, Set<string>>();
  private readonly mirrors: () => Map<string, Mirror>;
  private readonly dirty = new Set<string>();
  private readonly timer: NodeJS.Timeout;
  stats = { dropped: 0 };

  constructor(http: Server, mirrors: () => Map<string, Mirror>) {
    this.mirrors = mirrors;
    this.server = new WebSocketServer({ server: http, path: "/live" });
    this.server.on("connection", (socket) => this.connected(socket));
    this.timer = setInterval(() => this.flushBooks(), BOOK_INTERVAL_MS);
  }

  clients(): number {
    return this.subscribers.size;
  }

  /** A book changed; it goes out with the next conflated batch. */
  bookChanged(symbol: string): void {
    this.dirty.add(symbol);
  }

  trade(tick: Tick): void {
    const message = JSON.stringify({
      type: "trade",
      symbol: tick.symbol,
      priceCents: tick.priceCents,
      qty: tick.size,
      aggressor: tick.aggressor,
      ts: new Date(Number(tick.tsNs / 1_000_000n)).toISOString(),
      tradeId: tick.tradeId,
    });
    for (const [socket, symbols] of this.subscribers) {
      if (symbols.has(tick.symbol)) this.send(socket, message);
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const socket of this.subscribers.keys()) socket.terminate();
    this.server.close();
  }

  private connected(socket: WebSocket): void {
    this.subscribers.set(socket, new Set());
    socket.on("message", (data) => {
      let request: { subscribe?: unknown; unsubscribe?: unknown };
      try {
        request = JSON.parse(String(data)) as typeof request;
      } catch {
        socket.close(1003, "send JSON");
        return;
      }
      const symbols = this.subscribers.get(socket);
      if (!symbols) return;
      for (const symbol of strings(request.unsubscribe)) symbols.delete(symbol);
      for (const symbol of strings(request.subscribe)) {
        if (!this.mirrors().has(symbol) || symbols.size >= MAX_SYMBOLS_PER_CLIENT) continue;
        symbols.add(symbol);
        this.send(socket, this.bookMessage(symbol)); // the current state straight away
      }
    });
    socket.on("close", () => this.subscribers.delete(socket));
    socket.on("error", () => this.subscribers.delete(socket));
  }

  private flushBooks(): void {
    if (this.dirty.size === 0) return;
    const messages = new Map([...this.dirty].map((symbol) => [symbol, this.bookMessage(symbol)]));
    this.dirty.clear();
    for (const [socket, symbols] of this.subscribers) {
      for (const [symbol, message] of messages) {
        if (symbols.has(symbol)) this.send(socket, message);
      }
    }
  }

  private bookMessage(symbol: string): string {
    const mirror = this.mirrors().get(symbol);
    const { bids, asks } = mirror?.book(BOOK_DEPTH) ?? { bids: [], asks: [] };
    // live: false while the book is stale (before a snapshot, after a gap). A browser
    // should grey it out rather than show prices it cannot trust.
    return JSON.stringify({ type: "book", symbol, live: mirror?.isLive() ?? false, bids, asks });
  }

  private send(socket: WebSocket, message: string): void {
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.stats.dropped += 1;
      this.subscribers.delete(socket);
      socket.terminate();
      return;
    }
    socket.send(message);
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
