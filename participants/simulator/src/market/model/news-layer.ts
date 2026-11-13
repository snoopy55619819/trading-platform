// What news does to the price (ADR 0006): a headline moves fair value to a new level at once,
// and heats the symbol up. While it is warm, the random walk moves faster (and the agents
// read the same heat to trade more, in bigger sizes, and quote wider and smaller). The heat
// fades in wall-clock time: SIM_SPEED is for watching prices, not for rushing bursts. What a
// headline is worth, and how heat scales each thing, is in market/news.ts.

import { cool, volMultiplier } from "../news.ts";
import type { Layer, Moment } from "./layer.ts";

export class NewsLayer implements Layer {
  readonly name = "news";
  /** How stirred up the symbol is by recent news: 0 is calm, 1 just after major news. */
  heat = 0;

  volatility(): number {
    return volMultiplier(this.heat);
  }

  advance(moment: Moment): void {
    this.heat = cool(this.heat, moment.wallSec);
  }

  /**
   * A headline arrived: heats the symbol up to `heat`, and returns the move in log fair value
   * to make now. A second story while the first is still warm does not add up past 1.
   */
  headline(logMove: number, heat: number): number {
    this.heat = Math.min(1, Math.max(this.heat, heat));
    return logMove;
  }
}
