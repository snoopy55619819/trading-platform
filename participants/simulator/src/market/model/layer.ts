// The price model is built from layers (ADR 0008). Fair value is a random walk in log price;
// each layer adds one thing a real price does on top of that walk, and knows nothing about
// the others. To add one: write a class with the hooks it needs, give its tunable numbers
// names and comments in its own file, add it to `standardLayers` (model/layers.ts), and
// measure the market before and after with `pnpm realism`.
//
// Each step, FairValue (market/fair-value.ts) asks every layer, in order:
//
//   volatility()   how much faster the walk moves right now (multiplied together)
//   drift(moment)  a move in log fair value this step that is not random: a pull, the
//                  rest of a news move still arriving, impact fading away (added together)
//
// then takes the step (the sum of the drifts plus the walk's random move, kept inside the
// venue's price band), and finally calls every layer's advance(moment, moved) so it can
// update its own state: cool down, decay, count time, react to how far the price moved. A layer may also take events from outside the
// model, the way the news layer takes headlines; those are its own methods.
//
// Hooks a layer does not need are left out. Layers must draw random numbers only in
// advance() or their own event methods, never in volatility() or drift(), which can be asked
// more than once a step (the market makers ask for volatility to size their spreads).

import type { Rng } from "../rng.ts";

/** One step of the model, as every layer sees it. */
export interface Moment {
  /** Model seconds the step covers: wall-clock seconds times SIM_SPEED. */
  dtSec: number;
  /** Wall-clock seconds the step covers. A burst of activity fades in real time. */
  wallSec: number;
  /** The time-of-day activity multiplier (market/diurnal.ts). */
  activity: number;
  /** ln(fair value / reference price) before the step. */
  logRatio: number;
  /** The part of the venue's band fair value may use, as ln(price / reference): floor below 0, limit above. */
  band: { floor: number; limit: number };
  /** The model's random numbers, for advance() only. */
  rng: Rng;
}

export interface Layer {
  /** For reports and tests. */
  readonly name: string;
  /** A multiplier on the random walk's volatility, at this moment. */
  volatility?(): number;
  /** A move in log fair value this step, not counting the random walk. */
  drift?(moment: Moment): number;
  /**
   * Called once the step is taken, to update the layer's own state. `moved` is how far log
   * fair value moved since the previous step ended: this step's walk and drifts, plus any
   * news or trades in between.
   */
  advance?(moment: Moment, moved: number): void;
}
