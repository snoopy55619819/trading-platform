// What a headline is worth to this firm. The newswire says what happened (a category, a
// tone, how big a surprise); it never says what that does to the price. This is our model
// (ADR 0006):
//
//   a new level  fair value moves once, up for good news and down for bad, by about
//                dailyVol x jumpSize x (0.3 for MINOR, 0.75 for MAJOR), give or take 30%.
//                Neutral news moves nothing.
//   a burst      the symbol "heats up": 1 for MAJOR news, 0.6 for MINOR, 0.2 for neutral,
//                halving every two minutes. While it is warm, fair value moves faster,
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

// Calibrated so news adds as much volatility as the random jumps it replaced. Those came
// about twice a day for a typical company, each sized dailyVol x jumpSize x a standard
// normal; the newswire sends about 10 moving stories a day, a quarter of them MAJOR, in
// the same proportions per company. Equal variance per day means the average squared size
// here is a fifth: 0.75 x 0.3^2 + 0.25 x 0.75^2, times about 1.03 for the surprise, is 0.21.
const SIZE = { MINOR: 0.3, MAJOR: 0.75 } as const;
const HEAT = { MINOR: 0.6, MAJOR: 1 } as const;
const NEUTRAL_HEAT = 0.2;
/** How fast a burst fades, in wall-clock seconds. */
export const HEAT_HALF_LIFE_SEC = 120;

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

/** At full heat: fair value moves 4 times as fast... */
export const volMultiplier = (heat: number): number => 1 + 3 * heat;
/** ...takers trade 5 times as often... */
export const tradeRateMultiplier = (heat: number): number => 1 + 4 * heat;
/** ...in orders twice the size... */
export const tradeSizeMultiplier = (heat: number): number => 1 + heat;
/** ...and market makers show half their usual size. */
export const quoteSizeMultiplier = (heat: number): number => 1 - 0.5 * heat;
