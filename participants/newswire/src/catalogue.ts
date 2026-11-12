// What the wire can say: every kind of story, its tone, and how it is written. Each wording is
// a headline (`{name}` becomes the company's name) with its own short story, so the details
// always match the headline they sit under. A MAJOR story gets stronger words, and bigger
// numbers, than a MINOR one. Neutral stories have one strength, MINOR.
//
// Every figure is invented: plausible, consistent within the story, and scaled by severity
// (a major earnings miss misses by more). Nothing here is real.
//
// Pure apart from the random choices it is handed, so it is tested directly.

import type { Rng } from "./rng.ts";

export const TONES = ["POSITIVE", "NEGATIVE", "NEUTRAL"] as const;
export type Tone = (typeof TONES)[number];
export const SEVERITIES = ["MINOR", "MAJOR"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What a story's body can draw on. */
export interface StoryContext {
  name: string;
  /** The first word of the name: "Acme", "Helix". */
  short: string;
  ticker: string;
  /** The listing's reference price, for price targets. */
  referenceCents: number;
  /** The quarter just reported, from the publish date: "third-quarter". */
  quarter: string;
  rng: Rng;
}

interface Wording {
  headline: string;
  body: (s: StoryContext) => string;
}

interface Kind {
  tone: Tone;
  minor: readonly Wording[];
  /** Absent for neutral stories, which are never MAJOR. */
  major?: readonly Wording[];
}

// ---------- invented details ----------

const between = (s: StoryContext, low: number, high: number): number => low + (high - low) * s.rng.next();
const whole = (s: StoryContext, low: number, high: number): number => Math.round(between(s, low, high));
const pick = <T>(s: StoryContext, items: readonly T[]): T => s.rng.pick(items);
const dollars = (amount: number): string => `$${amount.toFixed(2)}`;
/** An amount in millions: "$412 million", or "$1.25 billion" from a thousand million up. */
const millions = (amount: number): string =>
  amount >= 1000 ? `$${(amount / 1000).toFixed(2)} billion` : `$${Math.round(amount)} million`;
const pct = (amount: number): string => `${amount.toFixed(1)}%`;
/** A price target `changePct` from the reference price: whole dollars, or cents under $20. */
const target = (s: StoryContext, changePct: number): string => {
  const price = (s.referenceCents / 100) * (1 + changePct / 100);
  return price < 20 ? dollars(price) : `$${Math.round(price)}`;
};

const BROKERS = ["Northgate Securities", "Calder Research", "Harbor & Vale", "Whitlock Partners", "Ashford Capital Markets"];
const CUSTOMERS = ["a national retailer", "a regional utility", "a European carmaker", "a government agency", "a large logistics group", "a hospital network"];
const AREAS = ["how it books revenue on long contracts", "its safety reporting", "sales practices in one division", "how it valued its inventory"];
const PRODUCTS: Record<string, string> = { HELX: "treatment", CRUX: "chip", IONX: "coating", JOLT: "drink", ECHO: "service" };
const SECTORS: Record<string, string> = {
  ACME: "industrials", BLTZ: "transport", CRUX: "semiconductor", DYNE: "energy", ECHO: "telecoms",
  FLUX: "materials", GRID: "utilities", HELX: "healthcare", IONX: "chemicals", JOLT: "consumer",
};
const product = (s: StoryContext) => PRODUCTS[s.ticker] ?? "product";
const sector = (s: StoryContext) => SECTORS[s.ticker] ?? "industry";

/** Annual revenue, in millions, roughly in line with the company's size. */
const annualRevenue = (s: StoryContext) => Math.round(between(s, 900, 6000) / 10) * 10;

// ---------- stories, shared by wordings that say the same thing ----------

function earnings(s: StoryContext, beat: boolean, major: boolean): string {
  const expected = between(s, 0.4, 3.2);
  const surprise = (major ? between(s, 12, 30) : between(s, 2, 6)) / 100;
  const actual = expected * (beat ? 1 + surprise : 1 - surprise);
  const revenue = annualRevenue(s) / 4;
  const growth = beat ? (major ? between(s, 9, 18) : between(s, 2, 6)) : major ? -between(s, 3, 9) : between(s, 0.5, 2);
  const quote = beat
    ? major ? "Demand was stronger than we planned for in every region" : "A steady quarter, and we kept costs where we wanted them"
    : major ? "We did not execute as well as we should have this quarter" : "Costs ran a little ahead of plan, and we are dealing with that";
  return (
    `${s.name} reported ${s.quarter} earnings of ${dollars(actual)} a share, ` +
    `${beat ? "ahead of" : "short of"} the ${dollars(expected)} analysts had expected. ` +
    `Revenue ${growth >= 0 ? "rose" : "fell"} ${pct(Math.abs(growth))} from a year earlier to ${millions(revenue)}. ` +
    `"${quote}," its chief executive said.`
  );
}

function guidance(s: StoryContext, up: boolean, major: boolean, onlyOneEnd: boolean): string {
  const low = annualRevenue(s);
  const high = Math.round(low * 1.04);
  const change = (major ? between(s, 6, 12) : between(s, 1, 3)) / 100;
  const moved = (x: number) => Math.round(x * (up ? 1 + change : 1 - change));
  const newLow = up || !onlyOneEnd ? moved(low) : low;
  const newHigh = !up || !onlyOneEnd ? moved(high) : high;
  const reason = up
    ? pick(s, ["stronger orders from its largest customers", "better pricing", "lower input costs"])
    : pick(s, ["softer orders", "higher input costs", "delays at two large customers"]);
  return (
    `${s.name} now expects full-year revenue of ${millions(Math.min(newLow, newHigh))} to ${millions(Math.max(newLow, newHigh))}, ` +
    `${up ? "up" : "down"} from ${millions(low)} to ${millions(high)}. The company pointed to ${reason}.`
  );
}

function rating(s: StoryContext, up: boolean, major: boolean): string {
  const broker = pick(s, BROKERS);
  const move = (up ? 1 : -1) * (major ? between(s, 25, 40) : between(s, 10, 20));
  const [from, to] = up ? ["neutral", major ? "strong buy" : "outperform"] : ["outperform", major ? "sell" : "neutral"];
  return (
    `${broker} moved ${s.name} to ${to} from ${from} and set a price target of ${target(s, move)}. ` +
    `The analyst pointed to ${up ? "improving margins and a strong order book" : "rising costs and slowing orders"}.`
  );
}

// ---------- the catalogue ----------

export const CATALOGUE = {
  EARNINGS_BEAT: {
    tone: "POSITIVE",
    minor: [
      { headline: "{name} edges past quarterly estimates", body: (s) => earnings(s, true, false) },
      { headline: "{name} quarterly profit slightly ahead of forecasts", body: (s) => earnings(s, true, false) },
    ],
    major: [
      { headline: "{name} smashes estimates as orders surge", body: (s) => earnings(s, true, true) },
      { headline: "{name} posts record quarter, well above forecasts", body: (s) => earnings(s, true, true) },
    ],
  },
  GUIDANCE_RAISED: {
    tone: "POSITIVE",
    minor: [
      { headline: "{name} nudges up full-year outlook", body: (s) => guidance(s, true, false, false) },
      { headline: "{name} raises low end of annual guidance", body: (s) => guidance(s, true, false, true) },
    ],
    major: [
      { headline: "{name} sharply raises full-year forecast", body: (s) => guidance(s, true, true, false) },
      { headline: "{name} lifts outlook on strong demand", body: (s) => guidance(s, true, true, false) },
    ],
  },
  ANALYST_UPGRADE: {
    tone: "POSITIVE",
    minor: [
      { headline: "Analyst lifts {name} to outperform", body: (s) => rating(s, true, false) },
      {
        headline: "{name} price target raised at a major bank",
        body: (s) =>
          `${pick(s, BROKERS)} raised its price target on ${s.name} to ${target(s, between(s, 10, 20))} from ` +
          `${target(s, between(s, -2, 4))}, keeping its buy rating. It expects margins to keep improving.`,
      },
    ],
    major: [
      {
        headline: "{name} upgraded to strong buy by two brokers",
        body: (s) => {
          const [a, b] = [pick(s, BROKERS.slice(0, 2)), pick(s, BROKERS.slice(2))];
          return (
            `${a} and ${b} both moved ${s.name} to strong buy on the same morning, with targets of ` +
            `${target(s, between(s, 25, 35))} and ${target(s, between(s, 30, 45))}. Both cited a faster recovery in orders.`
          );
        },
      },
      {
        headline: "Analysts turn bullish on {name} after site visit",
        body: (s) =>
          `Analysts from three brokers raised their ratings after touring ${s.short}'s main site this week. ` +
          `Their average price target is now ${target(s, between(s, 25, 40))}, with new capacity coming on early.`,
      },
    ],
  },
  CONTRACT_WIN: {
    tone: "POSITIVE",
    minor: [
      {
        headline: "{name} wins regional supply contract",
        body: (s) =>
          `${s.name} will supply ${pick(s, CUSTOMERS)} under a ${whole(s, 2, 3)}-year contract worth about ` +
          `${millions(between(s, 20, 80))}. Deliveries start next quarter.`,
      },
      {
        headline: "{name} extends deal with long-standing customer",
        body: (s) =>
          `${s.name} extended its agreement with ${pick(s, CUSTOMERS)} by ${whole(s, 2, 4)} years, ` +
          `adding about ${millions(between(s, 30, 90))} of expected revenue. Terms were otherwise unchanged.`,
      },
    ],
    major: [
      {
        headline: "{name} lands its largest contract to date",
        body: (s) =>
          `${s.name} signed a ${whole(s, 5, 7)}-year contract with ${pick(s, CUSTOMERS)} worth about ` +
          `${millions(between(s, 300, 900))}, its largest ever. It expects to hire for a new production line.`,
      },
      {
        headline: "{name} wins multi-year deal worth a year of revenue",
        body: (s) => {
          const revenue = annualRevenue(s);
          return (
            `${s.name} won a ${whole(s, 6, 8)}-year deal with ${pick(s, CUSTOMERS)} worth about ${millions(revenue)}, ` +
            `roughly what it earned in revenue last year. Work begins in the spring.`
          );
        },
      },
    ],
  },
  PRODUCT_APPROVAL: {
    tone: "POSITIVE",
    minor: [
      {
        headline: "{name} gets approval for a new product line",
        body: (s) =>
          `The regulator cleared ${s.short}'s new ${product(s)} line for sale. ` +
          `${s.short} expects the first sales next quarter and a small contribution this year.`,
      },
      {
        headline: "{name} clears an early regulatory review",
        body: (s) =>
          `${s.name} passed the first stage of the regulator's review of its new ${product(s)}. ` +
          `A full decision is expected within ${whole(s, 6, 12)} months.`,
      },
    ],
    major: [
      {
        headline: "Regulator approves {name} flagship product",
        body: (s) =>
          `The regulator approved ${s.short}'s flagship ${product(s)}, which the company has said could double its ` +
          `revenue within ${whole(s, 3, 5)} years. Sales start next month.`,
      },
      {
        headline: "{name} wins full approval ahead of schedule",
        body: (s) =>
          `${s.name} received full approval for its new ${product(s)} ${whole(s, 3, 6)} months earlier than planned. ` +
          `It will bring forward its launch and hiring.`,
      },
    ],
  },
  BUYBACK: {
    tone: "POSITIVE",
    minor: [
      {
        headline: "{name} announces modest share buyback",
        body: (s) =>
          `${s.name} will buy back up to ${pct(between(s, 1, 3))} of its shares over the next year, ` +
          `paid for from cash on hand.`,
      },
      {
        headline: "{name} adds to existing buyback program",
        body: (s) =>
          `${s.name} added ${millions(between(s, 25, 100))} to its share buyback program, ` +
          `which now runs to the end of next year.`,
      },
    ],
    major: [
      {
        headline: "{name} unveils large share buyback",
        body: (s) =>
          `${s.name} will buy back up to ${pct(between(s, 8, 15))} of its shares, the largest buyback in its history, ` +
          `saying the shares are worth more than the market price.`,
      },
      {
        headline: "{name} to return a fifth of its value to shareholders",
        body: (s) =>
          `${s.name} plans to return about ${pct(between(s, 19, 21))} of its market value to shareholders over two years ` +
          `through buybacks and a special dividend, funded by the sale of a minor division.`,
      },
    ],
  },
  EARNINGS_MISS: {
    tone: "NEGATIVE",
    minor: [
      { headline: "{name} falls just short of quarterly estimates", body: (s) => earnings(s, false, false) },
      { headline: "{name} quarterly profit slightly below forecasts", body: (s) => earnings(s, false, false) },
    ],
    major: [
      { headline: "{name} misses estimates by a wide margin", body: (s) => earnings(s, false, true) },
      { headline: "{name} profit slumps as costs climb", body: (s) => earnings(s, false, true) },
    ],
  },
  GUIDANCE_CUT: {
    tone: "NEGATIVE",
    minor: [
      { headline: "{name} trims full-year outlook", body: (s) => guidance(s, false, false, false) },
      { headline: "{name} lowers top end of annual guidance", body: (s) => guidance(s, false, false, true) },
    ],
    major: [
      { headline: "{name} slashes full-year forecast", body: (s) => guidance(s, false, true, false) },
      {
        headline: "{name} withdraws guidance, citing weak demand",
        body: (s) => {
          const low = annualRevenue(s);
          return (
            `${s.name} withdrew its forecast of ${millions(low)} to ${millions(Math.round(low * 1.04))} in full-year ` +
            `revenue, saying demand had weakened faster than expected. It will give a new range when it can.`
          );
        },
      },
    ],
  },
  ANALYST_DOWNGRADE: {
    tone: "NEGATIVE",
    minor: [
      { headline: "Analyst trims {name} to neutral", body: (s) => rating(s, false, false) },
      {
        headline: "{name} price target cut at a major bank",
        body: (s) =>
          `${pick(s, BROKERS)} cut its price target on ${s.name} to ${target(s, -between(s, 10, 20))} from ` +
          `${target(s, between(s, -4, 2))}, keeping its hold rating. It expects costs to stay high.`,
      },
    ],
    major: [
      {
        headline: "{name} downgraded to sell by two brokers",
        body: (s) => {
          const [a, b] = [pick(s, BROKERS.slice(0, 2)), pick(s, BROKERS.slice(2))];
          return (
            `${a} and ${b} both cut ${s.name} to sell, with targets of ${target(s, -between(s, 25, 35))} and ` +
            `${target(s, -between(s, 30, 40))}. Both expect orders to fall through next year.`
          );
        },
      },
      {
        headline: "Analysts turn bearish on {name} over margins",
        body: (s) =>
          `Three brokers lowered their ratings on ${s.name} in a day, warning that margins could fall by ` +
          `${whole(s, 2, 5)} points as prices come under pressure. Their average target is now ${target(s, -between(s, 25, 40))}.`,
      },
    ],
  },
  PRODUCT_RECALL: {
    tone: "NEGATIVE",
    minor: [
      {
        headline: "{name} recalls a small batch of products",
        body: (s) =>
          `${s.name} is recalling about ${whole(s, 2, 15).toLocaleString("en-US")},000 units of one ${product(s)} ` +
          `as a precaution after a fault in a single batch. It expects the cost to be small.`,
      },
      {
        headline: "{name} pauses shipments of one product for checks",
        body: (s) =>
          `${s.name} paused shipments of one ${product(s)} while it checks a supplier's parts. ` +
          `It expects to resume within ${whole(s, 2, 4)} weeks.`,
      },
    ],
    major: [
      {
        headline: "{name} announces wide product recall",
        body: (s) =>
          `${s.name} is recalling about ${whole(s, 150, 600)},000 units of its ${product(s)} after reports of a fault, ` +
          `at an expected cost of ${millions(between(s, 40, 160))}.`,
      },
      {
        headline: "{name} halts sales of its main product line",
        body: (s) =>
          `${s.name} stopped selling its main ${product(s)} line while it investigates a safety problem. ` +
          `The line made up about ${pct(between(s, 30, 50))} of revenue last year.`,
      },
    ],
  },
  EXECUTIVE_DEPARTURE: {
    tone: "NEGATIVE",
    minor: [
      {
        headline: "{name} finance chief to step down",
        body: (s) =>
          `${s.name}'s chief financial officer will leave at the end of the quarter after ${whole(s, 4, 11)} years. ` +
          `A search for a successor is under way.`,
      },
      {
        headline: "{name} division head leaves for a rival",
        body: (s) =>
          `The head of ${s.short}'s largest division has left to join a competitor. ` +
          `The division's deputy head will run it while the company looks for a replacement.`,
      },
    ],
    major: [
      {
        headline: "{name} chief executive resigns unexpectedly",
        body: (s) =>
          `${s.name}'s chief executive resigned with immediate effect, and the company gave no reason. ` +
          `The chair will act as interim chief executive.`,
      },
      {
        headline: "{name} chief executive and chair both depart",
        body: (s) =>
          `${s.name}'s chief executive and chair both left the company. ` +
          `The senior independent director becomes interim chair while the board looks for both roles.`,
      },
    ],
  },
  REGULATORY_PROBE: {
    tone: "NEGATIVE",
    minor: [
      {
        headline: "{name} receives information request from regulator",
        body: (s) =>
          `${s.name} said in a filing that it had received a request for information about ${pick(s, AREAS)}. ` +
          `It said it was cooperating and did not expect a material effect.`,
      },
      {
        headline: "Regulator reviews {name} disclosures",
        body: (s) =>
          `The regulator is reviewing ${s.short}'s disclosures about ${pick(s, AREAS)}. ` +
          `${s.short} said it believed its reporting was accurate.`,
      },
    ],
    major: [
      {
        headline: "Regulator opens formal investigation into {name}",
        body: (s) =>
          `The regulator opened a formal investigation into ${pick(s, AREAS)} at ${s.name}, ` +
          `which could lead to fines. The company said it would cooperate fully.`,
      },
      {
        headline: "{name} faces fine over compliance failures",
        body: (s) =>
          `${s.name} could be fined up to ${millions(between(s, 50, 250))} after the regulator found failures in ` +
          `${pick(s, AREAS)}. The company has ${whole(s, 30, 60)} days to respond.`,
      },
    ],
  },
  CONFERENCE: {
    tone: "NEUTRAL",
    minor: [
      {
        headline: "{name} to present at industry conference next week",
        body: (s) =>
          `${s.name}'s chief executive and finance chief will speak at a ${sector(s)} conference next week. ` +
          `The talk will be webcast.`,
      },
      {
        headline: "{name} to host investor day next month",
        body: (s) => `${s.name} will host an investor day next month, with updates from each division and a question session.`,
      },
    ],
  },
  DIVIDEND_DECLARED: {
    tone: "NEUTRAL",
    minor: [
      {
        headline: "{name} declares regular quarterly dividend",
        body: (s) => `${s.name} declared its regular quarterly dividend of ${dollars(between(s, 0.1, 0.8))} a share, payable next month.`,
      },
      {
        headline: "{name} keeps dividend unchanged",
        body: (s) => `${s.name} kept its quarterly dividend at ${dollars(between(s, 0.1, 0.8))} a share, as expected.`,
      },
    ],
  },
  EXECUTIVE_APPOINTED: {
    tone: "NEUTRAL",
    minor: [
      {
        headline: "{name} names new head of investor relations",
        body: (s) =>
          `${s.name} appointed a new head of investor relations, who joins from another ${sector(s)} company ` +
          `and starts next month.`,
      },
      {
        headline: "{name} appoints independent director",
        body: (s) =>
          `${s.name} added an independent director to its board, bringing ${whole(s, 15, 30)} years of ` +
          `experience in finance and the ${sector(s)} industry.`,
      },
    ],
  },
  ANNUAL_MEETING: {
    tone: "NEUTRAL",
    minor: [
      {
        headline: "{name} sets date for annual shareholder meeting",
        body: (s) => `${s.name} will hold its annual shareholder meeting online in ${whole(s, 5, 8)} weeks. Notice of the meeting is out today.`,
      },
      {
        headline: "{name} shareholders approve all resolutions",
        body: (s) => `Every resolution at ${s.short}'s annual meeting passed, each with at least ${pct(between(s, 88, 98))} of the votes cast.`,
      },
    ],
  },
  INDEX_REVIEW: {
    tone: "NEUTRAL",
    minor: [
      {
        headline: "{name} weighting unchanged in index review",
        body: (s) => `${s.name}'s weight in the Alpha Composite index is unchanged after the quarterly review.`,
      },
      {
        headline: "{name} stays in index after quarterly review",
        body: (s) => `${s.name} keeps its place in the Alpha Composite index. Changes from the review take effect next week.`,
      },
    ],
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

const QUARTERS = ["fourth-quarter", "first-quarter", "second-quarter", "third-quarter"];

/** The quarter companies report in the weeks after `now`: the one just finished. */
export function quarterReported(now: Date): string {
  return QUARTERS[Math.floor(now.getUTCMonth() / 3)]!;
}

/** A headline and its story: one of the category's wordings for this strength. */
export function write(
  category: Category,
  severity: Severity,
  company: { ticker: string; name: string; referenceCents: number },
  rng: Rng,
  now = new Date(),
): { headline: string; body: string } {
  const kind: Kind = CATALOGUE[category];
  const wording = rng.pick(severity === "MAJOR" && kind.major ? kind.major : kind.minor);
  const context: StoryContext = {
    name: company.name,
    short: company.name.split(" ")[0] ?? company.name,
    ticker: company.ticker,
    referenceCents: company.referenceCents,
    quarter: quarterReported(now),
    rng,
  };
  return { headline: wording.headline.replaceAll("{name}", company.name), body: wording.body(context) };
}
