// What news does to the price (ADR 0006, reshaped in ADR 0008 stage 4). A headline moves
// fair value to a new level, but over minutes, the way real prices discover what news is
// worth: part of the move at once, the rest arriving over the next few minutes, and
// sometimes an overshoot that is then given back. It also heats the symbol up; while it is
// warm, the random walk moves faster (and the agents read the same heat to trade more, in
// bigger sizes, and quote wider and smaller). All of it runs in wall-clock time, like the
// trading it drives: SIM_SPEED is for watching prices, not for rushing news. What a headline
// is worth, and how heat scales each thing, is in market/news.ts.

import { cool, volMultiplier } from "../news.ts";
import type { Rng } from "../rng.ts";
import type { Layer, Moment } from "./layer.ts";

/** The share of a headline's move that lands at once; the rest arrives over minutes. */
export const AT_ONCE = 0.5;
/** How fast the rest arrives: the time constant, in seconds (about 63% of it by then). */
export const ARRIVAL_SEC = 4 * 60;
/** How often the market overshoots and then gives some back. */
export const OVERSHOOT_CHANCE = 0.3;
/** How far past the move an overshoot goes, as a share of the move. */
export const OVERSHOOT_MIN = 0.1;
export const OVERSHOOT_MAX = 0.3;
/** How fast an overshoot is given back: half of it every this many seconds. */
export const OVERSHOOT_HALF_LIFE_SEC = 20 * 60;

export class NewsLayer implements Layer {
  readonly name = "news";
  /** How stirred up the symbol is by recent news: 0 is calm, 1 just after major news. */
  heat = 0;
  /** The part of recent moves still to arrive, in log price. */
  private arriving = 0;
  /** Overshoot still to be given back, in log price. */
  private overshoot = 0;

  volatility(): number {
    return volMultiplier(this.heat);
  }

  drift(moment: Moment): number {
    const arrives = this.arriving * (1 - Math.exp(-moment.wallSec / ARRIVAL_SEC));
    const givenBack = this.overshoot * (1 - 0.5 ** (moment.wallSec / OVERSHOOT_HALF_LIFE_SEC));
    return arrives - givenBack;
  }

  advance(moment: Moment): void {
    this.arriving *= Math.exp(-moment.wallSec / ARRIVAL_SEC);
    this.overshoot *= 0.5 ** (moment.wallSec / OVERSHOOT_HALF_LIFE_SEC);
    this.heat = cool(this.heat, moment.wallSec);
  }

  /**
   * A headline arrived: heats the symbol up to `heat`, and returns the part of `logMove` to
   * make now. The rest arrives over the next minutes, with sometimes an overshoot that is
   * then given back. A second story while the first is still warm does not heat past 1.
   */
  headline(logMove: number, heat: number, rng: Rng): number {
    this.heat = Math.min(1, Math.max(this.heat, heat));
    if (logMove === 0) return 0;
    let rest = (1 - AT_ONCE) * logMove;
    if (rng.next() < OVERSHOOT_CHANCE) {
      const extra = logMove * (OVERSHOOT_MIN + (OVERSHOOT_MAX - OVERSHOOT_MIN) * rng.next());
      rest += extra; // arrives with the rest...
      this.overshoot += extra; // ...while being given back, more slowly
    }
    this.arriving += rest;
    return AT_ONCE * logMove;
  }
}
