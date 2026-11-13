// When each company has news, and what kind. Each symbol has two independent Poisson
// processes: stories that should move the price, and neutral ones that should not. The
// rates are per company, so the biotech is in the news far more than the utility, and
// follow the time of day (hours.ts): busiest around the open and the close, quiet overnight.
//
// Seeded, so the same seed gives the same stories at the same model times.

import { type Category, type Severity, type Tone, pickCategory, write } from "./catalogue.ts";
import { newsHours } from "./hours.ts";
import type { Rng } from "./rng.ts";

const SECONDS_PER_DAY = 86_400;
/** Price-moving stories per symbol per day at a rate of 1: one every 2.4 hours on average. */
export const MOVING_PER_DAY = 10;
/** Neutral stories per symbol per day: about as many as moving ones. */
export const NEUTRAL_PER_DAY = 10;
/** Share of moving stories that are MAJOR. */
export const MAJOR_SHARE = 0.25;

/** How newsworthy each company is, as a multiple of the base rates. 1 unless listed. */
const NEWSWORTHY: Partial<Record<string, number>> = {
  HELX: 2, // biotech: trials, approvals, recalls
  GRID: 0.5, // utility: little happens
  JOLT: 0.5, // consumer staples: likewise
};

export function newsworthiness(ticker: string): number {
  return NEWSWORTHY[ticker] ?? 1;
}

export interface Company {
  ticker: string;
  name: string;
  /** The listing's reference price, for price targets in stories. */
  referenceCents: number;
}

/** A story before it is stamped with an id and a time. */
export interface Story {
  symbol: string;
  headline: string;
  /** A few sentences under the headline. */
  body: string;
  category: Category;
  tone: Tone;
  severity: Severity;
}

export class Schedule {
  private readonly companies: readonly Company[];
  private readonly rate: number;
  private readonly rng: Rng;

  /** `rate` multiplies every company's rates: 20 shows a story every few seconds. */
  constructor(companies: readonly Company[], rate: number, rng: Rng) {
    this.companies = companies;
    this.rate = rate;
    this.rng = rng;
  }

  /**
   * The stories that happen in the next `dtSec` seconds, in no particular order. `now` sets
   * how busy the time of day is, and which quarter an earnings story reports.
   */
  step(dtSec: number, now = new Date()): Story[] {
    const stories: Story[] = [];
    const hours = newsHours(now);
    for (const company of this.companies) {
      const perSec = (newsworthiness(company.ticker) * this.rate * hours) / SECONDS_PER_DAY;
      if (this.rng.chance(MOVING_PER_DAY * perSec, dtSec)) stories.push(this.moving(company, now));
      if (this.rng.chance(NEUTRAL_PER_DAY * perSec, dtSec)) stories.push(this.story(company, "NEUTRAL", "MINOR", now));
    }
    return stories;
  }

  private moving(company: Company, now: Date): Story {
    // Good and bad news equally likely, so news alone gives prices no drift.
    const tone: Tone = this.rng.next() < 0.5 ? "POSITIVE" : "NEGATIVE";
    const severity: Severity = this.rng.next() < MAJOR_SHARE ? "MAJOR" : "MINOR";
    return this.story(company, tone, severity, now);
  }

  private story(company: Company, tone: Tone, severity: Severity, now: Date): Story {
    const category = pickCategory(company.ticker, tone, this.rng);
    const { headline, body } = write(category, severity, company, this.rng, now);
    return { symbol: company.ticker, headline, body, category, tone, severity };
  }
}
