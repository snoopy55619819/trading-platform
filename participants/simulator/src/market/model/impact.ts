// Trading moves the price (ADR 0008, stage 2). Every trade on the public tape nudges fair
// value toward the side that took liquidity: a buyer lifting the offer pushes it up. That is
// how real prices form: market makers who keep getting hit on one side learn something and
// move their quotes. It is what turns the takers into a market: momentum traders now make
// trends, and mean-reversion traders lean against them.
//
// The size follows the square-root law, the best established result about price impact:
//
//   move = LAMBDA x daily volatility x sqrt(trade size / daily volume)
//
// so a trade of 1% of a day's volume moves the price about a tenth of LAMBDA x a day's
// volatility, and a thin market (overnight) moves more per share than a busy one. Daily
// volume is estimated from the tape itself, so it follows SIM_ACTIVITY and the time of day
// with no setting. Part of each move stays; the rest fades away over minutes, as the order
// book refills behind it. Its clocks are wall-clock time, like the trading it follows:
// SIM_SPEED speeds up the random walk, not the agents.
//
// It reads only the public feed (trades and their aggressor side), so every trade counts,
// the simulator's own and real users' alike, and nothing private is needed.

import type { Layer, Moment } from "./layer.ts";

/** Impact as a multiple of daily volatility for a trade of a whole day's volume. */
export const LAMBDA = 0.5;
/** The share of each move that stays; the rest fades away. */
export const PERMANENT = 0.4;
/** How fast the fading part goes, in seconds. */
export const FADE_HALF_LIFE_SEC = 5 * 60;
/** How far back the estimate of daily volume looks (an exponential average), in seconds. */
export const VOLUME_WINDOW_SEC = 30 * 60;
/** No impact until the volume estimate has seen this much of the tape. */
export const WARM_UP_SEC = 3 * 60;
/** One trade never moves fair value more than this many days' volatility. */
export const MAX_MOVE_DAILY_VOLS = 1;

const SECONDS_PER_DAY = 86_400;

export class ImpactLayer implements Layer {
  readonly name = "trading impact";
  private readonly dailyVol: number;
  /** SIM_IMPACT: a multiple of LAMBDA, 0 for no impact at all. */
  private readonly scale: number;
  /** The fading part of recent impact still in fair value, in log price. */
  private transient = 0;
  /** Shares traded per second, averaged over about VOLUME_WINDOW_SEC. */
  private volumePerSec = 0;
  /** Seconds of tape seen, for the warm-up. */
  private seenSec = 0;

  constructor(dailyVol: number, scale = 1) {
    this.dailyVol = dailyVol;
    this.scale = scale;
  }

  /** The fading part's share that goes this step: undone as a drift. */
  drift(moment: Moment): number {
    return -this.transient * (1 - 0.5 ** (moment.wallSec / FADE_HALF_LIFE_SEC));
  }

  advance(moment: Moment): void {
    this.transient *= 0.5 ** (moment.wallSec / FADE_HALF_LIFE_SEC);
    this.volumePerSec *= Math.exp(-moment.wallSec / VOLUME_WINDOW_SEC);
    this.seenSec += moment.wallSec;
  }

  /** The current estimate of a day's volume, in shares, or undefined while warming up. */
  dailyVolume(): number | undefined {
    if (this.seenSec < WARM_UP_SEC || this.volumePerSec <= 0) return undefined;
    // The average has only been filling for seenSec: scale it up until the window is full.
    const filled = 1 - Math.exp(-this.seenSec / VOLUME_WINDOW_SEC);
    return (this.volumePerSec / filled) * SECONDS_PER_DAY;
  }

  /**
   * A trade on the tape: returns the move in log fair value to make now, and remembers the
   * part of it that will fade.
   */
  trade(qty: number, buyerAggressed: boolean): number {
    const volume = this.dailyVolume();
    this.volumePerSec += qty / VOLUME_WINDOW_SEC;
    if (volume === undefined || this.scale === 0) return 0;
    const size = Math.min(MAX_MOVE_DAILY_VOLS, this.scale * LAMBDA * Math.sqrt(qty / volume)) * this.dailyVol;
    const move = buyerAggressed ? size : -size;
    this.transient += (1 - PERMANENT) * move;
    return move;
  }
}
