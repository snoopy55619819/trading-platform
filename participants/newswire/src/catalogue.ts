// What the wire can say: every kind of story, its tone, and how it is worded. Wordings are
// templates; `{name}` becomes the company's name. A MAJOR story gets stronger words than a
// MINOR one. Neutral stories have one strength, MINOR.
//
// Pure apart from the random choices it is handed, so it is tested directly.

import type { Rng } from "./rng.ts";

export const TONES = ["POSITIVE", "NEGATIVE", "NEUTRAL"] as const;
export type Tone = (typeof TONES)[number];
export const SEVERITIES = ["MINOR", "MAJOR"] as const;
export type Severity = (typeof SEVERITIES)[number];

interface Kind {
  tone: Tone;
  minor: readonly string[];
  /** Absent for neutral stories, which are never MAJOR. */
  major?: readonly string[];
}

export const CATALOGUE = {
  EARNINGS_BEAT: {
    tone: "POSITIVE",
    minor: ["{name} edges past quarterly estimates", "{name} quarterly profit slightly ahead of forecasts"],
    major: ["{name} smashes estimates as orders surge", "{name} posts record quarter, well above forecasts"],
  },
  GUIDANCE_RAISED: {
    tone: "POSITIVE",
    minor: ["{name} nudges up full-year outlook", "{name} raises low end of annual guidance"],
    major: ["{name} sharply raises full-year forecast", "{name} lifts outlook on strong demand"],
  },
  ANALYST_UPGRADE: {
    tone: "POSITIVE",
    minor: ["Analyst lifts {name} to outperform", "{name} price target raised at a major bank"],
    major: ["{name} upgraded to strong buy by two brokers", "Analysts turn bullish on {name} after site visit"],
  },
  CONTRACT_WIN: {
    tone: "POSITIVE",
    minor: ["{name} wins regional supply contract", "{name} extends deal with long-standing customer"],
    major: ["{name} lands its largest contract to date", "{name} wins multi-year deal worth a year of revenue"],
  },
  PRODUCT_APPROVAL: {
    tone: "POSITIVE",
    minor: ["{name} gets approval for a new product line", "{name} clears an early regulatory review"],
    major: ["Regulator approves {name} flagship product", "{name} wins full approval ahead of schedule"],
  },
  BUYBACK: {
    tone: "POSITIVE",
    minor: ["{name} announces modest share buyback", "{name} adds to existing buyback program"],
    major: ["{name} unveils large share buyback", "{name} to return a fifth of its value to shareholders"],
  },
  EARNINGS_MISS: {
    tone: "NEGATIVE",
    minor: ["{name} falls just short of quarterly estimates", "{name} quarterly profit slightly below forecasts"],
    major: ["{name} misses estimates by a wide margin", "{name} profit slumps as costs climb"],
  },
  GUIDANCE_CUT: {
    tone: "NEGATIVE",
    minor: ["{name} trims full-year outlook", "{name} lowers top end of annual guidance"],
    major: ["{name} slashes full-year forecast", "{name} withdraws guidance, citing weak demand"],
  },
  ANALYST_DOWNGRADE: {
    tone: "NEGATIVE",
    minor: ["Analyst trims {name} to neutral", "{name} price target cut at a major bank"],
    major: ["{name} downgraded to sell by two brokers", "Analysts turn bearish on {name} over margins"],
  },
  PRODUCT_RECALL: {
    tone: "NEGATIVE",
    minor: ["{name} recalls a small batch of products", "{name} pauses shipments of one product for checks"],
    major: ["{name} announces wide product recall", "{name} halts sales of its main product line"],
  },
  EXECUTIVE_DEPARTURE: {
    tone: "NEGATIVE",
    minor: ["{name} finance chief to step down", "{name} division head leaves for a rival"],
    major: ["{name} chief executive resigns unexpectedly", "{name} chief executive and chair both depart"],
  },
  REGULATORY_PROBE: {
    tone: "NEGATIVE",
    minor: ["{name} receives information request from regulator", "Regulator reviews {name} disclosures"],
    major: ["Regulator opens formal investigation into {name}", "{name} faces fine over compliance failures"],
  },
  CONFERENCE: {
    tone: "NEUTRAL",
    minor: ["{name} to present at industry conference next week", "{name} to host investor day next month"],
  },
  DIVIDEND_DECLARED: {
    tone: "NEUTRAL",
    minor: ["{name} declares regular quarterly dividend", "{name} keeps dividend unchanged"],
  },
  EXECUTIVE_APPOINTED: {
    tone: "NEUTRAL",
    minor: ["{name} names new head of investor relations", "{name} appoints independent director"],
  },
  ANNUAL_MEETING: {
    tone: "NEUTRAL",
    minor: ["{name} sets date for annual shareholder meeting", "{name} shareholders approve all resolutions"],
  },
  INDEX_REVIEW: {
    tone: "NEUTRAL",
    minor: ["{name} weighting unchanged in index review", "{name} stays in index after quarterly review"],
  },
} as const satisfies Record<string, Kind>;

export type Category = keyof typeof CATALOGUE;
export const CATEGORIES = Object.keys(CATALOGUE) as Category[];

/**
 * How likely each kind of story is for a company, relative to the others of the same tone.
 * 1 unless listed. Product approvals are for the companies that have products to approve.
 */
const WEIGHTS: Partial<Record<string, Partial<Record<Category, number>>>> = {
  HELX: { PRODUCT_APPROVAL: 4, PRODUCT_RECALL: 2, REGULATORY_PROBE: 2 },
  CRUX: { PRODUCT_APPROVAL: 1, CONTRACT_WIN: 2 },
  IONX: { PRODUCT_APPROVAL: 1, PRODUCT_RECALL: 2 },
  GRID: { REGULATORY_PROBE: 2 },
};
const NO_APPROVALS = 0;

export function weightFor(ticker: string, category: Category): number {
  const own = WEIGHTS[ticker]?.[category];
  if (own !== undefined) return own;
  return category === "PRODUCT_APPROVAL" ? NO_APPROVALS : 1;
}

/** Picks a kind of story with this tone for this company. */
export function pickCategory(ticker: string, tone: Tone, rng: Rng): Category {
  const choices = CATEGORIES.filter((c) => CATALOGUE[c].tone === tone).map((c) => ({ c, w: weightFor(ticker, c) }));
  const total = choices.reduce((sum, { w }) => sum + w, 0);
  let roll = rng.next() * total;
  for (const { c, w } of choices) {
    roll -= w;
    if (roll < 0) return c;
  }
  return choices.at(-1)!.c;
}

/** The headline's text: one of the category's wordings for this strength, with the name in. */
export function write(category: Category, severity: Severity, companyName: string, rng: Rng): string {
  const kind: Kind = CATALOGUE[category];
  const wordings = severity === "MAJOR" && kind.major ? kind.major : kind.minor;
  return rng.pick(wordings).replaceAll("{name}", companyName);
}
