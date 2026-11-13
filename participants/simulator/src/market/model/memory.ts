// Volatility with memory (ADR 0008, stage 3). Real prices have busy stretches and quiet
// ones: a big move makes more big moves likely for a while ("volatility clustering", the
// most visible fact about real price series). A plain random walk has none: every minute is
// as calm as the last.
//
// This is GARCH(1,1), the standard model for it, run once a minute:
//
//   h = OMEGA + ALPHA x e + BETA x h
//
// h is a multiplier on the walk's variance, 1 on average. e is how much the price actually
// moved over the last minute, compared with what the walk alone would move it (1 means as
// expected). Everything counts: the walk, news, trading impact. So a headline or a burst of
// trading leaves the symbol jumpier for the next half hour or so, and a calm spell calms it.
// OMEGA = 1 - ALPHA - BETA keeps h's average at 1, so a symbol's daily volatility stays
// about what its profile says.

import { WALK_DAY_SECONDS } from "../diurnal.ts";
import type { Layer, Moment } from "./layer.ts";

/** How much the last minute's surprise raises volatility. */
export const ALPHA = 0.08;
/** How much volatility carries over from minute to minute. ALPHA + BETA under 1. */
export const BETA = 0.91;
const OMEGA = 1 - ALPHA - BETA;
/** A minute counts at most this many times its expected variance (one huge news move must not stall the model). */
export const SURPRISE_CAP = 20;
/** Volatility never goes beyond this many times normal (its square root, in variance). */
export const MAX_VARIANCE = 9;
const MINUTE_SEC = 60;

export class VolatilityMemory implements Layer {
  readonly name = "volatility memory";
  private readonly dailyVol: number;
  /** The variance multiplier, 1 on average. */
  private h = 1;
  /** This minute so far: how far the price moved (squared), what the walk alone would give, and how long. */
  private moved2 = 0;
  private expected2 = 0;
  private elapsed = 0;

  constructor(dailyVol: number) {
    this.dailyVol = dailyVol;
  }

  volatility(): number {
    return Math.sqrt(this.h);
  }

  advance(moment: Moment, moved: number): void {
    this.moved2 += moved * moved;
    this.expected2 += (this.dailyVol * moment.activity) ** 2 * (moment.dtSec / WALK_DAY_SECONDS);
    this.elapsed += moment.dtSec;
    if (this.elapsed < MINUTE_SEC) return;
    const surprise = this.expected2 > 0 ? Math.min(SURPRISE_CAP, this.moved2 / this.expected2) : 1;
    this.h = Math.min(MAX_VARIANCE, OMEGA + ALPHA * surprise + BETA * this.h);
    this.moved2 = 0;
    this.expected2 = 0;
    this.elapsed = 0;
  }
}
