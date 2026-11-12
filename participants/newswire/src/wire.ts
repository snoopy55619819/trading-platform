// The wire itself: stamps each story with an id and a time, keeps the latest ones for
// catch-up, and hands each new headline to whoever is listening.
//
// Memory only. After a restart there is no history, which is fine: clients store what they
// need, and a client asking for news since before the restart just gets what there is.

import { ulid } from "./ids.ts";
import type { Story } from "./schedule.ts";

/** A published headline, exactly as it goes on the wire (spec/README.md). */
export interface Headline extends Story {
  id: string;
  /** ISO 8601, UTC, milliseconds. */
  ts: string;
}

/** Headlines kept for `GET /headlines?since=`. */
export const KEPT = 1000;

export class Wire {
  private readonly kept: Headline[] = [];
  private readonly listeners = new Set<(headline: Headline) => void>();
  private readonly keep: number;

  constructor(keep = KEPT) {
    this.keep = keep;
  }

  publish(story: Story, now = Date.now()): Headline {
    const headline: Headline = { id: ulid(now), ts: new Date(now).toISOString(), ...story };
    this.kept.push(headline);
    if (this.kept.length > this.keep) this.kept.splice(0, this.kept.length - this.keep);
    for (const listener of this.listeners) listener(headline);
    return headline;
  }

  /**
   * Headlines published at or after `since`, oldest first. Inclusive, so a client asking
   * from the time of its newest headline also gets any others from that same millisecond;
   * it drops the one it already has by id.
   */
  since(since: Date): Headline[] {
    const from = since.getTime();
    return this.kept.filter((h) => Date.parse(h.ts) >= from);
  }

  listen(listener: (headline: Headline) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
