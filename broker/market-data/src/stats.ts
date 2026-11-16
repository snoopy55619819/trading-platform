// Live platform stats (ADR 0016): the exchange's own numbers, from VenueStats on its feed,
// joined with this service's, once a second. Pushed to every browser on /live, and kept for
// five minutes so a page can draw a short trend as soon as it opens (GET /stats).
//
// Everything here is a total across the whole market: nothing names a participant.

import type { VenueStats } from "../gen/marketdata_pb.js";

/** The exchange's numbers, as published (spec 1.4.0), in the browser's field names. */
export interface VenueNumbers {
  businessDate: string;
  transactionsPerSec: number;
  newOrdersPerSec: number;
  cancelsPerSec: number;
  rejectsPerSec: number;
  tradesPerSec: number;
  sharesPerSec: number;
  notionalCentsPerSec: number;
  fixInPerSec: number;
  fixOutPerSec: number;
  feedMessagesPerSec: number;
  answerP50Us: number;
  answerP99Us: number;
  openOrders: number;
  sessions: number;
  transactionsToday: number;
  tradesToday: number;
}

/** This service's own numbers. */
export interface MarketDataNumbers {
  browsers: number;
  feedMessagesInPerSec: number;
  liveMessagesOutPerSec: number;
  tradesStoredPerSec: number;
  /** Since this service started. */
  feedGaps: number;
}

export interface Sample {
  ts: string;
  /** Null while the exchange has not been heard from in the last few seconds. */
  venue: VenueNumbers | null;
  marketData: MarketDataNumbers;
}

/** Cumulative counters, read once a second. */
export interface Counters {
  browsers: number;
  feedMessages: number;
  liveMessages: number;
  tradesStored: number;
  gaps: number;
}

/** Samples kept, one a second: five minutes. */
export const HISTORY = 300;
/** The exchange's numbers count as current for this long after they arrive. */
const VENUE_FRESH_MS = 3000;

export function venueNumbers(stats: VenueStats): VenueNumbers {
  return {
    businessDate: stats.businessDate,
    transactionsPerSec: stats.transactionsPerSec,
    newOrdersPerSec: stats.newOrdersPerSec,
    cancelsPerSec: stats.cancelsPerSec,
    rejectsPerSec: stats.rejectsPerSec,
    tradesPerSec: stats.tradesPerSec,
    sharesPerSec: stats.sharesPerSec,
    notionalCentsPerSec: stats.notionalCentsPerSec,
    fixInPerSec: stats.fixInPerSec,
    fixOutPerSec: stats.fixOutPerSec,
    feedMessagesPerSec: stats.feedMessagesPerSec,
    answerP50Us: stats.answerP50Us,
    answerP99Us: stats.answerP99Us,
    openOrders: stats.openOrders,
    sessions: stats.sessions,
    transactionsToday: Number(stats.transactionsToday),
    tradesToday: Number(stats.tradesToday),
  };
}

export class Stats {
  private venue: { numbers: VenueNumbers; at: number } | undefined;
  private last: { counters: Counters; at: number } | undefined;
  private readonly samples: Sample[] = [];

  /** The exchange's latest, as it arrives on the feed. */
  venueStats(stats: VenueStats, now: number): void {
    this.venue = { numbers: venueNumbers(stats), at: now };
  }

  /** Turns the counters into a sample: rates since the last one. Called once a second. */
  sample(counters: Counters, now: number): Sample {
    const secs = this.last ? Math.max(0.001, (now - this.last.at) / 1000) : 1;
    const rate = (key: keyof Counters) => (this.last ? (counters[key] - this.last.counters[key]) / secs : 0);
    const sample: Sample = {
      ts: new Date(now).toISOString(),
      venue: this.venue && now - this.venue.at <= VENUE_FRESH_MS ? this.venue.numbers : null,
      marketData: {
        browsers: counters.browsers,
        feedMessagesInPerSec: rate("feedMessages"),
        liveMessagesOutPerSec: rate("liveMessages"),
        tradesStoredPerSec: rate("tradesStored"),
        feedGaps: counters.gaps,
      },
    };
    this.last = { counters, at: now };
    this.samples.push(sample);
    if (this.samples.length > HISTORY) this.samples.shift();
    return sample;
  }

  latest(): Sample | null {
    return this.samples.at(-1) ?? null;
  }

  /** The last five minutes, oldest first, trimmed to what a trend line needs. */
  history(): { ts: string; transactionsPerSec: number | null; tradesPerSec: number | null; answerP99Us: number | null; liveMessagesOutPerSec: number }[] {
    return this.samples.map((s) => ({
      ts: s.ts,
      transactionsPerSec: s.venue?.transactionsPerSec ?? null,
      tradesPerSec: s.venue?.tradesPerSec ?? null,
      answerP99Us: s.venue?.answerP99Us ?? null,
      liveMessagesOutPerSec: s.marketData.liveMessagesOutPerSec,
    }));
  }
}
