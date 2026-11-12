// Subscribes to the newswire, following its spec (vendor/newswire/README.md):
//
//   1. open the WebSocket at /headlines;
//   2. catch up with GET /headlines?since=<the newest headline we have stored>, or
//      everything the wire still keeps, the first time;
//   3. keep every headline whose id we have not seen.
//
// The database does step 3: a headline is stored once (its id is the key), and only a newly
// stored one is handed on to browsers. So a catch-up overlapping live messages, or a
// restart, never shows a browser the same story twice.
//
// Headlines are handled one at a time, in arrival order. If the wire is down, prices still
// flow; there is just no news, and it reconnects with backoff.

import type { Db } from "../db.ts";
import { type Headline, checkHeadline, insertHeadline, newestHeadlineTs } from "../store/news.ts";

const EVERYTHING = "1970-01-01T00:00:00.000Z";

export class NewsSubscriber {
  private readonly url: string;
  private readonly catchUpUrl: string;
  private readonly db: Db;
  private readonly symbols: readonly string[];
  private readonly onNew: (headline: Headline) => void;
  private socket: WebSocket | undefined;
  private stopping = false;
  private backoffMs = 1000;
  private chain: Promise<void> = Promise.resolve();
  stats = { connected: false, received: 0, stored: 0, rejected: 0, reconnects: 0 };

  /** `url` is the WebSocket, `ws://host:port/headlines`; catch-up is the same path over HTTP. */
  constructor(url: string, db: Db, symbols: readonly string[], onNew: (headline: Headline) => void) {
    this.url = url;
    this.catchUpUrl = url.replace(/^ws/, "http");
    this.db = db;
    this.symbols = symbols;
    this.onNew = onNew;
  }

  start(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.backoffMs = 1000;
      this.stats.connected = true;
      console.log(`news: connected to ${this.url}`);
      void this.catchUp();
    });
    socket.addEventListener("message", (event) => {
      let value: unknown;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        value = undefined;
      }
      this.offer(value);
    });
    socket.addEventListener("close", () => {
      if (this.stopping || this.socket !== socket) return;
      if (this.stats.connected) console.warn("news: lost the newswire; reconnecting");
      this.stats.connected = false;
      this.stats.reconnects += 1;
      setTimeout(() => this.start(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  stop(): void {
    this.stopping = true;
    this.socket?.close();
  }

  /** Resolves once every headline received so far is stored. */
  settled(): Promise<void> {
    return this.chain;
  }

  private async catchUp(): Promise<void> {
    try {
      const since = (await newestHeadlineTs(this.db)) ?? EVERYTHING;
      const response = await fetch(`${this.catchUpUrl}?since=${encodeURIComponent(since)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { headlines } = (await response.json()) as { headlines: unknown[] };
      for (const headline of headlines) this.offer(headline);
    } catch (error) {
      console.warn(`news: catch-up failed (${(error as Error).message}); live headlines still arrive`);
    }
  }

  /** Checks, stores and passes on one headline, after every one before it. */
  private offer(value: unknown): void {
    this.stats.received += 1;
    const headline = checkHeadline(value, this.symbols);
    if (typeof headline === "string") {
      this.stats.rejected += 1;
      console.warn(`news: ignoring a headline: ${headline}`);
      return;
    }
    this.chain = this.chain
      .then(async () => {
        if (!(await insertHeadline(this.db, headline))) return; // already had it
        this.stats.stored += 1;
        this.onNew(headline);
      })
      .catch((error: Error) => console.error(`news: could not store ${headline.id}: ${error.message}`));
  }
}
