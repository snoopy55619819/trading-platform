// Every live stat the platform shows (ADR 0016): what it is called on screen, how its value
// is written, and one plain sentence saying what it means. Pure data and formatting, so the
// words are tested and reviewed in one place.
//
// On screen an order or a cancel is an "order update": a visitor seeing cancels outnumber
// trades fifty to one would think something was wrong. Most cancels are market makers moving
// a quote: they withdraw the old price and place the new one, since Alpha has no
// cancel-and-replace message.

import type { VenueStatus } from "../../api/backend.ts";
import type { MarketDataNumbers, StatsMessage, VenueNumbers } from "../../api/marketData.ts";

export type Format = "rate" | "count" | "money-rate" | "micros";

export type TrendKey = "transactionsPerSec" | "tradesPerSec" | "answerP99Us" | "liveMessagesOutPerSec";

export interface Stat {
  id: string;
  label: string;
  /** What it means, for a visitor: one sentence. */
  about: string;
  format: Format;
  value: number | null;
  /** A key of the five-minute history, if it has a trend line. */
  trend?: TrendKey;
}

export interface Group {
  title: string;
  /** Who reports these numbers. */
  source: string;
  stats: Stat[];
}

const n = (value: number, decimals: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** Writes a stat's value: rates with "/s", money in dollars, times in milliseconds. */
export function formatStat(format: Format, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  switch (format) {
    case "rate":
      return `${n(value, value > 0 && value < 10 ? 1 : 0)}/s`;
    case "count":
      return n(value, 0);
    case "money-rate":
      return `$${n(value / 100, 0)}/s`;
    case "micros":
      return value < 10_000 ? `${n(value / 1000, 1)} ms` : `${n(value / 1000, 0)} ms`;
  }
}

/** Order updates per trade: how much of the activity is quoting rather than trading. */
export function updatesPerTrade(venue: VenueNumbers | null): number | null {
  if (!venue || venue.tradesPerSec <= 0) return null;
  return venue.transactionsPerSec / venue.tradesPerSec;
}

export function groups(stats: StatsMessage | null, status: VenueStatus | undefined): Group[] {
  const v: Partial<VenueNumbers> = stats?.venue ?? {};
  const m: Partial<MarketDataNumbers> = stats?.marketData ?? {};
  const b = status?.activity;
  const at = (value: number | undefined) => value ?? null;
  return [
    {
      title: "The exchange",
      source: "Alpha Exchange, from its public market data feed",
      stats: [
        {
          id: "updates",
          label: "Order updates",
          format: "rate",
          value: at(v.transactionsPerSec),
          trend: "transactionsPerSec",
          about: "Every order placed and every order withdrawn, by everyone trading here. This is what the platform is measured by.",
        },
        {
          id: "new",
          label: "New orders",
          format: "rate",
          value: at(v.newOrdersPerSec),
          about: "Orders placed: to buy or sell at a price, or straight away at the market.",
        },
        {
          id: "withdrawn",
          label: "Withdrawn or moved",
          format: "rate",
          value: at(v.cancelsPerSec),
          about: "Orders taken off the book. Most are market makers moving a quote: they withdraw the old price and place the new one.",
        },
        {
          id: "refused",
          label: "Refused",
          format: "rate",
          value: at(v.rejectsPerSec),
          about: "Orders the exchange turned down before they reached the book: a price outside the day's band, say.",
        },
        {
          id: "trades",
          label: "Trades",
          format: "rate",
          value: at(v.tradesPerSec),
          trend: "tradesPerSec",
          about: "Matches: a buyer and a seller agreeing on a price. Each one prints in time and sales.",
        },
        {
          id: "ratio",
          label: "Order updates per trade",
          format: "count",
          value: updatesPerTrade(stats?.venue ?? null),
          about: "How much quoting goes on for each trade. Busy real stocks run at about 10 to 50.",
        },
        { id: "shares", label: "Shares traded", format: "rate", value: at(v.sharesPerSec), about: "How many shares change hands." },
        {
          id: "value",
          label: "Value traded",
          format: "money-rate",
          value: at(v.notionalCentsPerSec),
          about: "What those shares are worth, at the prices they traded.",
        },
        {
          id: "answer",
          label: "Answer time, typical",
          format: "micros",
          value: at(v.answerP50Us),
          about: "How long the exchange takes to answer an order, from receiving it to replying, saved first. Half are faster.",
        },
        {
          id: "answer99",
          label: "Answer time, slowest 1%",
          format: "micros",
          value: at(v.answerP99Us),
          trend: "answerP99Us",
          about: "99 in 100 orders are answered faster than this.",
        },
        {
          id: "fixIn",
          label: "Messages in",
          format: "rate",
          value: at(v.fixInPerSec),
          about: "FIX messages the exchange receives from the firms connected to it.",
        },
        {
          id: "fixOut",
          label: "Messages out",
          format: "rate",
          value: at(v.fixOutPerSec),
          about: "FIX messages it sends back: confirmations, fills and the like.",
        },
        {
          id: "feed",
          label: "Market data updates",
          format: "rate",
          value: at(v.feedMessagesPerSec),
          about: "Changes to the order books, and trades, published to everyone with no names on them.",
        },
        {
          id: "resting",
          label: "Orders resting",
          format: "count",
          value: at(v.openOrders),
          about: "Orders on the books right now, waiting for someone to trade with them.",
        },
        {
          id: "sessions",
          label: "Firms connected",
          format: "count",
          value: at(v.sessions),
          about: "Trading firms logged on to the exchange: the simulated traders, and this broker.",
        },
        {
          id: "updatesToday",
          label: "Order updates today",
          format: "count",
          value: at(v.transactionsToday),
          about: "Since the trading day began, at 21:00 UTC.",
        },
        {
          id: "tradesToday",
          label: "Trades today",
          format: "count",
          value: at(v.tradesToday),
          about: "Since the trading day began, at 21:00 UTC.",
        },
      ],
    },
    {
      title: "Market data",
      source: "The broker's market data service",
      stats: [
        {
          id: "viewers",
          label: "Screens watching",
          format: "count",
          value: at(m.browsers),
          about: "Browsers connected for live prices right now, yours included.",
        },
        {
          id: "mdIn",
          label: "Updates received",
          format: "rate",
          value: at(m.feedMessagesInPerSec),
          about: "What it takes in from the exchange's feed.",
        },
        {
          id: "mdOut",
          label: "Updates sent to screens",
          format: "rate",
          value: at(m.liveMessagesOutPerSec),
          trend: "liveMessagesOutPerSec",
          about: "What it sends on, to every screen together. Book changes are combined, so a screen gets at most ten a second per book.",
        },
        {
          id: "stored",
          label: "Trades saved",
          format: "rate",
          value: at(m.tradesStoredPerSec),
          about: "Trades written to the price history behind the charts.",
        },
        {
          id: "gaps",
          label: "Updates missed",
          format: "count",
          value: at(m.feedGaps),
          about: "Times it noticed a gap in the feed and asked for a fresh copy of the book. Zero is the goal.",
        },
      ],
    },
    {
      title: "The broker",
      source: "Your broker, which holds your account",
      stats: [
        {
          id: "requests",
          label: "App requests",
          format: "rate",
          value: b?.requestsPerSec ?? null,
          about: "What every screen of this app asks the broker for: orders, holdings, sign-ins.",
        },
        {
          id: "ordersToday",
          label: "Customer orders today",
          format: "count",
          value: b?.ordersToday ?? null,
          about: "Orders people placed through this app since the trading day began.",
        },
        { id: "accounts", label: "Accounts", format: "count", value: b?.accounts ?? null, about: "Accounts open at the broker." },
      ],
    },
  ];
}

/** An arrow's label: all of it, and what fits between two boxes side by side. */
export interface RateLabel {
  full: string;
  short: string;
}

/**
 * The guide's arrows, labelled with what is flowing along them now (ADR 0016), keyed by the
 * diagram's "from>to". Boxes keep the same ids in every flow, so one map serves them all.
 */
export function flowRates(stats: StatsMessage | null, status: VenueStatus | undefined): Map<string, RateLabel> {
  const rates = new Map<string, RateLabel>();
  const rate = (key: string, value: number, words: string) => {
    const short = formatStat("rate", value);
    rates.set(key, { full: `${short} ${words}`, short });
  };
  const v = stats?.venue;
  const m = stats?.marketData;
  if (v) {
    rate("firms>exchange", v.transactionsPerSec, "order updates");
    rate("exchange>md", v.feedMessagesPerSec, "updates");
  }
  if (m) {
    rate("md>mddb", m.tradesStoredPerSec, "trades saved");
    if (m.browsers > 0) rate("md>you", m.liveMessagesOutPerSec / m.browsers, "to each screen");
  }
  const b = status?.activity;
  if (b) {
    rate("you>broker", b.requestsPerSec, "requests");
    const orders = formatStat("count", b.ordersToday);
    rates.set("broker>exchange", { full: `${orders} orders today`, short: `${orders} today` });
  }
  return rates;
}
