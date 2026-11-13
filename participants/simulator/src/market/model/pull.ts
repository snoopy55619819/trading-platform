// A pull back toward the listing's reference price. The venue's price band is anchored on
// that reference price and does not move: a free random walk would, within days, wander
// outside the band and every order would be rejected. Weak in the middle of the band, with a
// half-life of a few days, so the price still trends and gaps for hours at a time; it grows
// near the edges (ADR 0008, stage 5), up to STEEPNESS + 1 times as strong at the edge, so
// prices turn back before they reach it rather than lying flat against a hard limit.

import type { Layer, Moment } from "./layer.ts";

const SECONDS_PER_DAY = 86_400;
/** How long it takes to close half the distance to the reference price, with no other moves. */
export const PULL_HALF_LIFE_DAYS = 3;
const PULL_PER_SEC = Math.LN2 / (PULL_HALF_LIFE_DAYS * SECONDS_PER_DAY);
/** How much stronger the pull is at the edge of the band: 1 + STEEPNESS times (half-life 8 hours). */
export const STEEPNESS = 8;

export class PullToReference implements Layer {
  readonly name = "pull to reference";

  drift(moment: Moment): number {
    const x = moment.logRatio;
    const edge = x > 0 ? moment.band.limit : moment.band.floor; // floor is negative: x / edge >= 0
    const strength = 1 + STEEPNESS * (x / edge) ** 4;
    return -PULL_PER_SEC * strength * x * moment.dtSec;
  }
}
