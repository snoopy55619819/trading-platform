// Measures how realistic the market's prices are (ADR 0008), from any market-data service's
// public HTTP API: the live site's, or a local one. It reads what any visitor's browser
// reads (GET /history and GET /news), so it measures what the market actually did, order
// book and all, not just the model.
//
//   pnpm realism                                  the live site, last 24 hours
//   pnpm realism --url http://127.0.0.1:8081 --hours 2
//   pnpm realism --hours 48 --out before.json     also save the numbers, to compare later
//   pnpm realism --compare before.json            print the change against a saved run
//
// What each number means, and what a real stock looks like, is in realism/stats.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ABS_LAGS, type Candle, type NewsEvent, RESPONSE_MINUTES, type Realism, measure } from "./stats.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "https://tradeplatform.dev/md" },
    hours: { type: "string", default: "24" },
    to: { type: "string" },
    symbols: { type: "string" },
    out: { type: "string" },
    compare: { type: "string" },
  },
});

const base = values.url.replace(/\/$/, "");
const hours = Number(values.hours);
if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours: a positive number");
const to = values.to ? new Date(values.to) : new Date();
const from = new Date(to.getTime() - hours * 3_600_000);
const listed = (
  JSON.parse(readFileSync(new URL("../vendor/exchange-alpha/listings.json", import.meta.url), "utf8")) as {
    symbols: { ticker: string; status: string }[];
  }
).symbols
  .filter((s) => s.status === "ACTIVE")
  .map((s) => s.ticker);
const symbols = values.symbols ? values.symbols.split(",") : listed;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** Candles in chunks: the API gives at most 1,000 a request. */
async function candles(symbol: string): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let start = from.getTime(); start < to.getTime(); start += 1000 * 60_000) {
    const end = Math.min(start + 1000 * 60_000, to.getTime());
    const q = `symbol=${symbol}&interval=1m&from=${new Date(start).toISOString()}&to=${new Date(end).toISOString()}`;
    out.push(...(await get<{ bars: Candle[] }>(`/history?${q}`)).bars);
  }
  return out;
}

/** Moving headlines in the window. The API returns the newest 200 a symbol at most. */
async function news(symbol: string): Promise<NewsEvent[]> {
  const { news } = await get<{ news: { ts: string; tone: string }[] }>(`/news?symbol=${symbol}&limit=200`);
  return news
    .filter((h) => h.tone !== "NEUTRAL" && Date.parse(h.ts) >= from.getTime() && Date.parse(h.ts) < to.getTime())
    .map((h) => ({ ts: h.ts, sign: h.tone === "POSITIVE" ? 1 : -1 }));
}

const results: Record<string, Realism> = {};
for (const symbol of symbols) results[symbol] = measure(await candles(symbol), await news(symbol));

// Every symbol, then the median of each column: one number to compare runs by.
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
type Column = [string, (r: Realism) => number, number];
const columns: Column[] = [
  ["flat %", (r) => r.flatShare * 100, 0],
  ["longest flat", (r) => r.longestFlat, 0],
  ["vol bps", (r) => r.volBps, 1],
  ["kurtosis", (r) => r.excessKurtosis, 1],
  ["acf1", (r) => r.acf1, 2],
  ["acf2", (r) => r.acf2, 2],
  ...ABS_LAGS.map((lag): Column => [`|r| ${lag}`, (r) => r.absAcf[lag] ?? 0, 2]),
  ["vol~|r|", (r) => r.volumeAbsCorr, 2],
  ["news", (r) => r.news.events, 0],
  ...RESPONSE_MINUTES.map((m): Column => [`news@${m}m`, (r) => r.news.path[m] ?? 0, 0]),
  ["news share %", (r) => r.news.newsShare * 100, 0],
];

const saved = values.compare ? (JSON.parse(readFileSync(values.compare, "utf8")) as { results: Record<string, Realism> }) : undefined;
const medians = (rs: Record<string, Realism>) => columns.map(([, f]) => median(Object.values(rs).map(f)));

const rows: string[][] = [["symbol", ...columns.map(([name]) => name)]];
for (const [symbol, r] of Object.entries(results)) rows.push([symbol, ...columns.map(([, f, d]) => f(r).toFixed(d))]);
rows.push(["median", ...medians(results).map((v, i) => v.toFixed(columns[i]![2]))]);
if (saved) rows.push(["was", ...medians(saved.results).map((v, i) => v.toFixed(columns[i]![2]))]);
const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
console.log(`${base}, ${from.toISOString()} to ${to.toISOString()}, one-minute candles\n`);
for (const row of rows) console.log(row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("  "));
console.log(
  "\nflat %: minutes with no price change. kurtosis: real stocks 5 to 20. acf: about 0 past lag 1." +
    "\n|r| n: clustering, real stocks positive and slow to fade. vol~|r|: volume and moves together." +
    "\nnews@n: average move n minutes after a moving headline, in bps, good and bad both counted as up." +
    "\n        a step is the same at every minute; a reaction over minutes grows toward 30m." +
    "\nnews share: share of all movement in the 5 minutes after headlines. See realism/stats.ts.",
);

if (values.out) {
  writeFileSync(values.out, `${JSON.stringify({ url: base, from, to, results }, null, 2)}\n`);
  console.log(`\nsaved ${values.out}`);
}
