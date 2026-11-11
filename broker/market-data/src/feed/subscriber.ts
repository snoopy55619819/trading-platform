// The connection to Alpha Exchange's market data feed: subscribes to every listed symbol,
// keeps a Mirror for each, asks for a fresh snapshot on a gap, and reconnects with backoff.

import { type MessageInitShape, create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { ClientMessageSchema, type FeedMessage, FeedMessageSchema, type TradePrint } from "../../gen/marketdata_pb.js";
import { Mirror } from "./mirror.ts";

export interface FeedEvents {
  onTrade(trade: TradePrint): void;
  /** A symbol's book changed (or went stale, or came back). */
  onBook(mirror: Mirror): void;
}

export class Subscriber {
  readonly mirrors = new Map<string, Mirror>();
  private readonly url: string;
  private readonly events: FeedEvents;
  private socket: WebSocket | undefined;
  private backoffMs = 1000;
  private stopping = false;
  stats = { gaps: 0, reconnects: 0, messages: 0 };

  constructor(url: string, symbols: string[], events: FeedEvents) {
    this.url = url;
    this.events = events;
    for (const symbol of symbols) this.mirrors.set(symbol, new Mirror(symbol));
  }

  start(): void {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.backoffMs = 1000;
      console.log(`feed: connected to ${this.url}`);
      this.send(socket, { case: "subscribe", value: { symbols: [...this.mirrors.keys()], depthLimit: 50 } });
    });
    socket.addEventListener("message", (event) => {
      this.stats.messages += 1;
      this.handle(socket, fromBinary(FeedMessageSchema, new Uint8Array(event.data as ArrayBuffer)));
    });
    socket.addEventListener("close", () => {
      if (this.stopping || this.socket !== socket) return;
      this.stats.reconnects += 1;
      // Every book is stale until its new snapshot arrives.
      for (const symbol of this.mirrors.keys()) {
        const fresh = new Mirror(symbol);
        this.mirrors.set(symbol, fresh);
        this.events.onBook(fresh);
      }
      console.warn(`feed: disconnected; reconnecting in ${this.backoffMs / 1000}s`);
      setTimeout(() => this.start(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  stop(): void {
    this.stopping = true;
    this.socket?.close();
  }

  /** Exposed for tests: applies one message as if it had arrived on the socket. */
  handle(socket: WebSocket | undefined, message: FeedMessage): void {
    for (const mirror of this.mirrors.values()) {
      const applied = mirror.apply(message);
      switch (applied.kind) {
        case "trade":
          this.events.onTrade(applied.trade);
          break;
        case "snapshot":
        case "level":
          this.events.onBook(mirror);
          break;
        case "gap":
          this.stats.gaps += 1;
          console.warn(`feed: ${mirror.symbol} lost messages (expected ${applied.expected}, got ${applied.received}); resyncing`);
          this.events.onBook(mirror);
          if (socket) this.send(socket, { case: "resync", value: { symbols: [mirror.symbol] } });
          break;
      }
    }
  }

  private send(socket: WebSocket, payload: NonNullable<MessageInitShape<typeof ClientMessageSchema>["payload"]>): void {
    socket.send(toBinary(ClientMessageSchema, create(ClientMessageSchema, { payload })));
  }
}
