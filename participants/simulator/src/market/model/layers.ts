// The layers every symbol's price model is built from, in order (ADR 0008). Add a layer
// here to give every symbol a new behaviour; measure with `pnpm realism` before and after.

import type { Profile } from "../fair-value.ts";
import { ImpactLayer } from "./impact.ts";
import type { Layer } from "./layer.ts";
import { NewsLayer } from "./news-layer.ts";
import { PullToReference } from "./pull.ts";

export interface StandardLayers {
  /** Every layer, in the order FairValue asks them. */
  all: Layer[];
  /** The one headlines are sent to. */
  news: NewsLayer;
  /** The one trades on the tape are sent to. */
  impact: ImpactLayer;
}

/** `impact` scales how hard trading moves the price (SIM_IMPACT); 0 turns it off. */
export function standardLayers(profile: Profile, impact = 1): StandardLayers {
  const news = new NewsLayer();
  const impactLayer = new ImpactLayer(profile.dailyVol, impact);
  return { all: [new PullToReference(), news, impactLayer], news, impact: impactLayer };
}
