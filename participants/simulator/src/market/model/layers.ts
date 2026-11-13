// The layers every symbol's price model is built from, in order (ADR 0008). Add a layer
// here to give every symbol a new behaviour; measure with `pnpm realism` before and after.

import type { Layer } from "./layer.ts";
import { NewsLayer } from "./news-layer.ts";
import { PullToReference } from "./pull.ts";

export interface StandardLayers {
  /** Every layer, in the order FairValue asks them. */
  all: Layer[];
  /** The one headlines are sent to. */
  news: NewsLayer;
}

export function standardLayers(): StandardLayers {
  const news = new NewsLayer();
  return { all: [new PullToReference(), news], news };
}
