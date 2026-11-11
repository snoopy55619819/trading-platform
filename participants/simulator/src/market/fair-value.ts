// Each symbol's hidden fair value: what it is "really" worth, which the market makers
// quote around and everyone else can only infer from prices.
//
// Geometric Brownian motion with occasional jumps ("news"), plus a weak pull back toward
// the listing's reference price. The pull is there because the venue's price band is
// anchored on that reference price and does not move: a free random walk would, within
// days, wander outside the band and every order would be rejected. With a half-life of a
// few days, the price still trends and gaps for hours at a time, but lives inside the band.
//
// This is the one place the simulator uses floating point for a price. It is a model
// quantity, never sent anywhere: every price that leaves it is rounded to integer cents
// on the symbol's tick first.

import type { Rng } from "./rng.ts";

export interface Profile {
  /** Typical daily move, as a fraction: 0.03 is 3% a day. */
  dailyVol: number;
  /** Jumps per day, on average. */
  jumpsPerDay: number;
  /** Typical jump size, as a multiple of a day's volatility. */
  jumpSize: number;
}

export interface Listing {
  ticker: string;
  tickCents: number;
  referenceCents: number;
  bandPct: number;
}

const SECONDS_PER_DAY = 86_400;
const PULL_HALF_LIFE_DAYS = 3;
const PULL_PER_SEC = Math.LN2 / (PULL_HALF_LIFE_DAYS * SECONDS_PER_DAY);
/** Fair value stays inside this share of the band, so quotes around it do too. */
const BAND_USE = 0.75;

export class FairValue {
  readonly listing: Listing;
  readonly profile: Profile;
  /** Model seconds per wall-clock second. Above 1 to watch hours of price in minutes. */
  private readonly speed: number;
  /** ln(fair value / reference price) */
  private logRatio = 0;
  /** Set when the last step contained a jump, for the market makers to react to. */
  jumped = false;

  constructor(listing: Listing, profile: Profile, speed = 1) {
    this.listing = listing;
    this.profile = profile;
    this.speed = speed;
  }

  /** Fair value in cents, unrounded. */
  value(): number {
    return this.listing.referenceCents * Math.exp(this.logRatio);
  }

  /** Volatility per wall-clock second at this moment, as a fraction of price. */
  volPerSec(activity: number): number {
    return this.modelVolPerSec(activity) * Math.sqrt(this.speed);
  }

  private modelVolPerSec(activity: number): number {
    return (this.profile.dailyVol / Math.sqrt(SECONDS_PER_DAY)) * activity;
  }

  /** Advances by `wallSec` of real time. `activity` scales volatility and jump rate. */
  step(wallSec: number, activity: number, rng: Rng): void {
    const dtSec = wallSec * this.speed;
    const vol = this.modelVolPerSec(activity);
    let move = -PULL_PER_SEC * this.logRatio * dtSec + vol * Math.sqrt(dtSec) * rng.normal();
    this.jumped = rng.chance((this.profile.jumpsPerDay * activity) / SECONDS_PER_DAY, dtSec);
    if (this.jumped) {
      move += this.profile.dailyVol * this.profile.jumpSize * rng.normal();
    }
    const limit = Math.log(1 + (this.listing.bandPct / 100) * BAND_USE);
    const floor = Math.log(1 - (this.listing.bandPct / 100) * BAND_USE);
    this.logRatio = Math.min(limit, Math.max(floor, this.logRatio + move));
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
