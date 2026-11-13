// A weak pull back toward the listing's reference price. The venue's price band is anchored
// on that reference price and does not move: a free random walk would, within days, wander
// outside the band and every order would be rejected. With a half-life of a few days, the
// price still trends and gaps for hours at a time, but lives inside the band.

import type { Layer, Moment } from "./layer.ts";

const SECONDS_PER_DAY = 86_400;
/** How long it takes to close half the distance to the reference price, with no other moves. */
export const PULL_HALF_LIFE_DAYS = 3;
const PULL_PER_SEC = Math.LN2 / (PULL_HALF_LIFE_DAYS * SECONDS_PER_DAY);

export class PullToReference implements Layer {
  readonly name = "pull to reference";

  drift(moment: Moment): number {
    return -PULL_PER_SEC * moment.logRatio * moment.dtSec;
  }
}
