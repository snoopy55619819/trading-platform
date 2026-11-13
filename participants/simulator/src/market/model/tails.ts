// Fat tails (ADR 0008, stage 3). In a real stock, big one-minute moves with no news behind
// them are far more common than a normal distribution allows: one-minute returns have an
// excess kurtosis of 5 to 20, where normal shocks give 0.
//
// Each minute this layer draws a fresh multiplier on the walk's variance from a scaled
// inverse chi-squared distribution, which makes the minute's move follow a Student-t
// distribution with DEGREES_OF_FREEDOM (a normal whose variance itself varies). Most minutes
// get a multiplier a little under 1; now and then one gets several times that, and that
// minute is a big candle. The average is 1, so daily volatility is unchanged.
//
// It must be per minute, not per step: the walk takes four steps a second, and fat-tailed
// steps would average out into a normal-looking minute.

import type { Layer, Moment } from "./layer.ts";
import type { Rng } from "../rng.ts";

/** Lower is fatter. 5 gives one-minute moves an excess kurtosis of about 6 on its own. */
export const DEGREES_OF_FREEDOM = 5;
/** No single minute is more than this many times its usual variance. */
export const MAX_MULTIPLIER = 12;
const MINUTE_SEC = 60;

/** A variance multiplier with mean 1 whose normal mixture is Student-t: (nu - 2) / chi-squared(nu). */
export function tailMultiplier(rng: Rng, nu = DEGREES_OF_FREEDOM): number {
  let chi2 = 0;
  for (let i = 0; i < nu; i++) chi2 += rng.normal() ** 2;
  return Math.min(MAX_MULTIPLIER, (nu - 2) / chi2);
}

export class FatTails implements Layer {
  readonly name = "fat tails";
  /** This minute's variance multiplier. The first minute is ordinary. */
  private multiplier = 1;
  private elapsed = 0;

  volatility(): number {
    return Math.sqrt(this.multiplier);
  }

  advance(moment: Moment): void {
    this.elapsed += moment.dtSec;
    if (this.elapsed < MINUTE_SEC) return;
    this.elapsed -= MINUTE_SEC * Math.floor(this.elapsed / MINUTE_SEC);
    this.multiplier = tailMultiplier(moment.rng);
  }
}
