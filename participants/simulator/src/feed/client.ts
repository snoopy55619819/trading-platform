// Subscribes to the venue's market data feed over WebSocket and keeps a Mirror per
// symbol. On a gap it asks for a fresh snapshot; on a dropped connection it reconnects
// and subscribes again, which brings a snapshot with it.

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { ClientMessageSchema, FeedMessageSchema } from "../../gen/marketdata_pb.js";
import { Mirror } from "./mirror.ts";

export interface FeedEvents {
  /** A trade print for `symbol`, applied in sequence. */
  onTrade(symbol: string, priceCents: number, qty: number): void;
}

export class FeedClient {
  readonly mirrors = new Map<string, Mirror>();
  private readonly url: string;
  private readonly events: FeedEvents;
  private socket: WebSocket | undefined;
  private stopping = false;
  private backoffMs = 1000;
  gaps = 0;

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
      const subscribe = create(ClientMessageSchema, {
        payload: {
          case: "subscribe",
          value: { symbols: [...this.mirrors.keys()], depthLimit: 10 },
        },
      });
      socket.send(toBinary(ClientMessageSchema, subscribe));
    });
    socket.addEventListener("message", (event) => {
      const message = fromBinary(FeedMessageSchema, new Uint8Array(event.data as ArrayBuffer));
      for (const mirror of this.mirrors.values()) {
        const applied = mirror.apply(message);
        if (applied.kind === "trade") {
          this.events.onTrade(mirror.symbol, applied.priceCents, applied.qty);
        } else if (applied.kind === "gap") {
          this.gaps += 1;
          console.warn(
            `feed: ${mirror.symbol} gap (expected ${applied.expected}, got ${applied.received}); resyncing`,
          );
          const resync = create(ClientMessageSchema, {
            payload: { case: "resync", value: { symbols: [mirror.symbol] } },
          });
          socket.send(toBinary(ClientMessageSchema, resync));
        }
      }
    });
    socket.addEventListener("close", () => {
      if (this.stopping || this.socket !== socket) return;
      // Until the new snapshot arrives the old books are stale; agents see no prices.
      for (const symbol of this.mirrors.keys()) this.mirrors.set(symbol, new Mirror(symbol));
      setTimeout(() => this.start(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  stop(): void {
    this.stopping = true;
    this.socket?.close();
  }
}
