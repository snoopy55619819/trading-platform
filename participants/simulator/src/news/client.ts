// Subscribes to the newswire, following its spec (vendor/newswire/README.md):
//
//   1. open the WebSocket at /headlines;
//   2. catch up with GET /headlines?since=<newest headline we have>, or, the first time,
//      since we started: news from before we were running is already in the price;
//   3. keep every headline whose id we have not seen, from either source.
//
// On a dropped connection it reconnects with backoff and catches up again. If the wire is
// down the market still moves, just without news.

import type { Headline } from "../market/news.ts";

/** Ids remembered for dropping repeats: far more than a catch-up ever overlaps. */
const REMEMBERED = 2000;

/** Which headlines are new, and where the next catch-up starts. Pure, so it is tested. */
export class NewsDesk {
  private readonly seen = new Set<string>();
  private newest: string;

  constructor(startedAt: Date) {
    this.newest = startedAt.toISOString();
  }

  /** True the first time an id is offered; false for a repeat. */
  accept(headline: Headline): boolean {
    if (this.seen.has(headline.id)) return false;
    this.seen.add(headline.id);
    if (this.seen.size > REMEMBERED) this.seen.delete(this.seen.values().next().value!);
    if (headline.ts > this.newest) this.newest = headline.ts; // ISO times sort as text
    return true;
  }

  /** The time to catch up from: the newest headline seen, or when we started. */
  since(): string {
    return this.newest;
  }
}

export class NewsClient {
  private readonly url: string;
  private readonly catchUpUrl: string;
  private readonly onHeadline: (headline: Headline) => void;
  private readonly desk = new NewsDesk(new Date());
  private socket: WebSocket | undefined;
  private stopping = false;
  private backoffMs = 1000;
  private warned = false;
  received = 0;

  /** `url` is the WebSocket, `ws://host:port/headlines`; catch-up is the same path over HTTP. */
  constructor(url: string, onHeadline: (headline: Headline) => void) {
    this.url = url;
    this.catchUpUrl = url.replace(/^ws/, "http");
    this.onHeadline = onHeadline;
  }

  start(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.backoffMs = 1000;
      if (this.warned) console.log("news: connected to the newswire again");
      this.warned = false;
      void this.catchUp();
    });
    socket.addEventListener("message", (event) => {
      this.offer(JSON.parse(String(event.data)) as Headline);
    });
    socket.addEventListener("close", () => {
      if (this.stopping || this.socket !== socket) return;
      if (!this.warned) console.warn(`news: no newswire at ${this.url}; trading without news, retrying`);
      this.warned = true;
      setTimeout(() => this.start(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  stop(): void {
    this.stopping = true;
    this.socket?.close();
  }

  private async catchUp(): Promise<void> {
    try {
      const response = await fetch(`${this.catchUpUrl}?since=${encodeURIComponent(this.desk.since())}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { headlines } = (await response.json()) as { headlines: Headline[] };
      for (const headline of headlines) this.offer(headline);
    } catch (error) {
      console.warn(`news: catch-up failed (${(error as Error).message}); live headlines still arrive`);
    }
  }

  private offer(headline: Headline): void {
    if (!this.desk.accept(headline)) return;
    this.received += 1;
    this.onHeadline(headline);
  }
}
