// What a headline is worth to this firm. The newswire says what happened (a category, a
// tone, how big a surprise); it never says what that does to the price. This is our model
// (ADR 0006):
//
//   a new level  fair value moves up for good news and down for bad, by about
//                dailyVol x jumpSize x (0.12 for MINOR, 0.35 for MAJOR), give or take 30%.
//                It plays out over minutes (model/news-layer.ts). Neutral news moves nothing.
//   a burst      the symbol "heats up": 1 for MAJOR news, 0.6 for MINOR, 0.2 for neutral,
//                halving every 15 minutes. While it is warm, fair value moves faster,
//                takers trade more often and in bigger sizes, and market makers quote
//                wider (their spread follows volatility) and smaller.
//
// Pure, so it is tested directly.

import type { Profile } from "./fair-value.ts";
import type { Rng } from "./rng.ts";

/** A headline as the newswire publishes it (vendor/newswire/README.md). */
export interface Headline {
  id: string;
  ts: string;
  symbol: string;
  headline: string;
  /** The story (spec 1.1.0). This firm trades on headlines and never reads it. */
  body?: string;
  category: string;
  tone: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  severity: "MINOR" | "MAJOR";
}

// Sized so news is under half of a symbol's daily movement, as in a real stock, not the
// roughly 90% it was (ADR 0008, stage 4). About 10 moving stories a day, a quarter MAJOR:
// the average squared size is 0.75 x 0.12^2 + 0.25 x 0.35^2, times about 1.03 for the
// surprise, so 0.043; times jumpSize^2 (2.25 for most) and 10 stories, about 1 day's
// variance from news, against about 1 from the walk (which now delivers the profile's full
// daily volatility, market/fair-value.ts) and more from trading. A MAJOR story still moves a
// typical symbol about 1.5%.
const SIZE = { MINOR: 0.12, MAJOR: 0.35 } as const;
const HEAT = { MINOR: 0.6, MAJOR: 1 } as const;
const NEUTRAL_HEAT = 0.2;
/**
 * How fast a burst fades, in wall-clock seconds. Real markets stay busier for tens of
 * minutes to hours after news; the volatility memory (model/memory.ts) carries the longer tail.
 */
export const HEAT_HALF_LIFE_SEC = 15 * 60;

/** The change in log fair value a headline is worth: 0 for neutral news. */
export function newsMove(headline: Pick<Headline, "tone" | "severity">, profile: Profile, rng: Rng): number {
  if (headline.tone === "NEUTRAL") return 0;
  const sign = headline.tone === "POSITIVE" ? 1 : -1;
  const surprise = 0.7 + 0.6 * rng.next(); // 0.7 to 1.3
  return sign * profile.dailyVol * profile.jumpSize * SIZE[headline.severity] * surprise;
}

/** How hot a headline makes its symbol, from 0 to 1. */
export function newsHeat(headline: Pick<Headline, "tone" | "severity">): number {
  return headline.tone === "NEUTRAL" ? NEUTRAL_HEAT : HEAT[headline.severity];
}

/** Heat after `dtSec` more seconds. */
export function cool(heat: number, dtSec: number): number {
  return heat * 0.5 ** (dtSec / HEAT_HALF_LIFE_SEC);
}

// Gentler than when bursts lasted two minutes: they now last seven times as long, and the
// volatility memory already makes a symbol jumpier after a big move.
/** At full heat: fair value moves 2.5 times as fast... */
export const volMultiplier = (heat: number): number => 1 + 1.5 * heat;
/** ...takers trade 3.5 times as often... */
export const tradeRateMultiplier = (heat: number): number => 1 + 2.5 * heat;
/** ...in orders 1.5 times the size... */
export const tradeSizeMultiplier = (heat: number): number => 1 + 0.5 * heat;
/** ...and market makers show 60% of their usual size. */
export const quoteSizeMultiplier = (heat: number): number => 1 - 0.4 * heat;
