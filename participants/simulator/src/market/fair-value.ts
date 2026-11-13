// Each symbol's hidden fair value: what it is "really" worth, which the market makers
// quote around and everyone else can only infer from prices.
//
// A random walk in log price (geometric Brownian motion), with layers on top that each add
// one thing a real price does (ADR 0008; market/model/). Today: a weak pull back toward
// the reference price, so it stays inside the venue's price band (model/pull.ts), and news,
// which moves it to a new level and heats it up (model/news-layer.ts; ADR 0006). There are
// no jumps of its own: every gap has a headline behind it. Whatever the layers do, fair
// value never leaves the part of the band it may use.
//
// This is the one place the simulator uses floating point for a price. It is a model
// quantity, never sent anywhere: every price that leaves it is rounded to integer cents
// on the symbol's tick first.

import type { Moment } from "./model/layer.ts";
import { type StandardLayers, standardLayers } from "./model/layers.ts";
import type { Rng } from "./rng.ts";

export interface Profile {
  /** Typical daily move, as a fraction: 0.03 is 3% a day. */
  dailyVol: number;
  /** How hard news hits, as a multiple of a day's volatility (market/news.ts). */
  jumpSize: number;
}

export interface Listing {
  ticker: string;
  tickCents: number;
  referenceCents: number;
  bandPct: number;
}

const SECONDS_PER_DAY = 86_400;
/** Fair value stays inside this share of the band, so quotes around it do too. */
const BAND_USE = 0.75;

export class FairValue {
  readonly listing: Listing;
  readonly profile: Profile;
  /** Model seconds per wall-clock second. Above 1 to watch hours of price in minutes. */
  private readonly speed: number;
  private readonly layers: StandardLayers;
  /** ln(fair value / reference) */
  private logRatio = 0;
  /** Set for one step after news moved the price, for the market makers to react to. */
  jumped = false;
  private shocked = false;

  constructor(listing: Listing, profile: Profile, speed = 1, layers: StandardLayers = standardLayers()) {
    this.listing = listing;
    this.profile = profile;
    this.speed = speed;
    this.layers = layers;
  }

  /** Fair value in cents, unrounded. */
  value(): number {
    return this.listing.referenceCents * Math.exp(this.logRatio);
  }

  /** How stirred up the symbol is by recent news: 0 is calm, 1 just after major news. */
  get heat(): number {
    return this.layers.news.heat;
  }

  /** The layers this price is built from, in order. */
  get layerNames(): string[] {
    return this.layers.all.map((l) => l.name);
  }

  /** Volatility per wall-clock second at this moment, as a fraction of price. */
  volPerSec(activity: number): number {
    return this.modelVolPerSec(activity) * Math.sqrt(this.speed);
  }

  private modelVolPerSec(activity: number): number {
    let vol = (this.profile.dailyVol / Math.sqrt(SECONDS_PER_DAY)) * activity;
    for (const layer of this.layers.all) if (layer.volatility) vol *= layer.volatility();
    return vol;
  }

  /** Advances by `wallSec` of real time. `activity` scales volatility. */
  step(wallSec: number, activity: number, rng: Rng): void {
    const moment: Moment = { dtSec: wallSec * this.speed, wallSec, activity, logRatio: this.logRatio };
    const vol = this.modelVolPerSec(activity);
    let drift = 0;
    for (const layer of this.layers.all) if (layer.drift) drift += layer.drift(moment);
    this.move(drift + vol * Math.sqrt(moment.dtSec) * rng.normal());
    this.jumped = this.shocked;
    this.shocked = false;
    for (const layer of this.layers.all) layer.advance?.(moment);
  }

  /**
   * News arrived: move fair value by `logMove` now (0 for neutral news) and heat the symbol
   * up to `heat` (model/news-layer.ts).
   */
  shock(logMove: number, heat: number): void {
    const move = this.layers.news.headline(logMove, heat);
    if (move !== 0) {
      this.move(move);
      this.shocked = true;
    }
  }

  /** Moves log fair value, staying inside the part of the band it may use. */
  private move(logMove: number): void {
    const limit = Math.log(1 + (this.listing.bandPct / 100) * BAND_USE);
    const floor = Math.log(1 - (this.listing.bandPct / 100) * BAND_USE);
    this.logRatio = Math.min(limit, Math.max(floor, this.logRatio + logMove));
  }
}

/** Rounds a model price to the nearest valid tick, in integer cents. */
export function toTick(cents: number, tickCents: number): number {
  return Math.max(tickCents, Math.round(cents / tickCents) * tickCents);
}

/** The venue's price band (inclusive), as the gateway checks it. */
export function withinBand(cents: number, listing: Listing): boolean {
  return Math.abs(cents - listing.referenceCents) * 100 <= listing.referenceCents * listing.bandPct;
}

