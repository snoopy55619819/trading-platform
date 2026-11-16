// The live stats the platform shows (ADR 0016): what each is called on screen, how its value
// is written, and one plain sentence saying what it means (shown on hover). Pure data and
// formatting, so the words are tested and reviewed in one place. A short list on purpose:
// the exchange reports more (spec 1.4.0) than a visitor needs to see.
//
// On screen an order or a cancel is an "order update": a visitor seeing cancels outnumber
// trades fifty to one would think something was wrong. Most cancels are market makers moving
// a quote: they withdraw the old price and place the new one, since Alpha has no
// cancel-and-replace message.

import type { VenueStatus } from "../../api/backend.ts";
import type { MarketDataNumbers, StatsMessage, VenueNumbers } from "../../api/marketData.ts";

export type Format = "rate" | "count" | "money-rate" | "micros";

export interface Stat {
  id: string;
  label: string;
  /** What it means, for a visitor: one sentence, shown on hover. */
  about: string;
  format: Format;
  value: number | null;
}

export interface Group {
  title: string;
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

export function groups(stats: StatsMessage | null, status: VenueStatus | undefined): Group[] {
  const v: Partial<VenueNumbers> = stats?.venue ?? {};
  const m: Partial<MarketDataNumbers> = stats?.marketData ?? {};
  const b = status?.activity;
  const at = (value: number | undefined) => value ?? null;
  return [
    {
      title: "The exchange",
      stats: [
        {
          id: "updates",
          label: "Order updates",
          format: "rate",
          value: at(v.transactionsPerSec),
          about:
            "Every order placed and every order withdrawn, by everyone trading here. Most withdrawals are market makers moving a quote: they withdraw the old price and place the new one.",
        },
        {
          id: "trades",
          label: "Trades",
          format: "rate",
          value: at(v.tradesPerSec),
          about: "Matches: a buyer and a seller agreeing on a price. Each one prints in time and sales.",
        },
        {
          id: "value",
          label: "Value traded",
          format: "money-rate",
          value: at(v.notionalCentsPerSec),
          about: "What the shares changing hands are worth, at the prices they traded.",
        },
        {
          id: "answer",
          label: "Answer time",
          format: "micros",
          value: at(v.answerP50Us),
          about: "How long the exchange typically takes to answer an order, from receiving it to replying, saved first. Half are faster.",
        },
        {
          id: "resting",
          label: "Orders resting",
          format: "count",
          value: at(v.openOrders),
          about: "Orders on the books right now, waiting for someone to trade with them.",
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
      stats: [
        {
          id: "mdOut",
          label: "Price updates sent",
          format: "rate",
          value: at(m.liveMessagesOutPerSec),
          about: "Live prices sent to every screen together. Book changes are combined, so a screen gets at most ten a second per book.",
        },
        {
          id: "viewers",
          label: "Screens watching",
          format: "count",
          value: at(m.browsers),
          about: "Browsers connected for live prices right now, yours included.",
        },
      ],
    },
    {
      title: "The broker",
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
