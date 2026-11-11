// broker-market-data: the broker's market data service. Both halves of it:
//
//   live     subscribes to Alpha Exchange's feed and fans prices out to browsers
//   history  stores every trade and rolls it into candles, served by GET /history
//
// Independent of the backend: its own database, its own vendored copy of the exchange's
// spec, no shared code. It lives on the anonymous public plane, so it never sees an account
// or an order id.
//
//     pnpm start
//
//   GET  /history?symbol=ACME&interval=1m&from=<ISO>&to=<ISO>   candles, oldest first
//   GET  /trades?symbol=ACME&limit=50                           latest trades, newest first
//   GET  /health                                                feed and fanout state
//   WS   /live                                                  see live/fanout.ts
//
// Configuration, all optional: MD_PORT (8081), MD_FEED_URL (from listings.json),
// MD_DATABASE_URL (the local container on 5434).

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { createPool } from "./db.ts";
import { Subscriber } from "./feed/subscriber.ts";
import { Fanout } from "./live/fanout.ts";
import { INTERVALS, INTERVAL_SECONDS, type Interval, bars, rollup } from "./store/rollup.ts";
import { type Tick, insertTicks, recentTrades, tickFrom } from "./store/ticks.ts";

const FLUSH_EVERY_MS = 250;
const ROLLUP_EVERY_MS = 1000;
const MAX_BARS = 1000;
const MAX_TRADES = 200;

interface Listings {
  venue: { market_data: { host: string; port: number } };
  market: { business_date_roll_utc: string };
  symbols: { ticker: string; status: string }[];
}
const listings = JSON.parse(
  readFileSync(new URL("../vendor/exchange-alpha/listings.json", import.meta.url), "utf8"),
) as Listings;
const symbols = listings.symbols.map((s) => s.ticker);
const dayRoll = listings.market.business_date_roll_utc;
const feedUrl =
  process.env.MD_FEED_URL ?? `ws://${listings.venue.market_data.host}:${listings.venue.market_data.port}`;

const pool = createPool();
let pending: Tick[] = [];
const stats = { stored: 0, duplicates: 0, rolledUp: 0 };

const http = createServer((req, res) => {
  void handle(req.url ?? "/").then(({ status, body }) => {
    // Public data: any page may read it, including the web client on another origin.
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  });
});

const subscriber = new Subscriber(feedUrl, symbols, {
  onTrade(trade) {
    const tick = tickFrom(trade);
    pending.push(tick);
    fanout.trade(tick);
  },
  onBook(mirror) {
    fanout.bookChanged(mirror.symbol);
  },
});
const fanout = new Fanout(http, () => subscriber.mirrors);

async function handle(path: string): Promise<{ status: number; body: object }> {
  const url = new URL(path, "http://localhost");
  try {
    if (url.pathname === "/health") {
      const live = [...subscriber.mirrors.values()].filter((m) => m.isLive()).length;
      return { status: 200, body: { feed: { ...subscriber.stats, liveBooks: live, symbols: symbols.length }, ...stats, clients: fanout.clients(), droppedClients: fanout.stats.dropped } };
    }
    if (url.pathname === "/history") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const interval = (url.searchParams.get("interval") ?? "1m") as Interval;
      if (!symbols.includes(symbol)) return { status: 400, body: { text: "symbol: one of the listed tickers" } };
      if (!INTERVALS.includes(interval)) return { status: 400, body: { text: `interval: one of ${INTERVALS.join(", ")}` } };
      const to = url.searchParams.has("to") ? new Date(url.searchParams.get("to")!) : new Date();
      const span = INTERVAL_SECONDS[interval] * 1000;
      const from = url.searchParams.has("from") ? new Date(url.searchParams.get("from")!) : new Date(to.getTime() - 300 * span);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        return { status: 400, body: { text: "from and to: ISO timestamps, from before to" } };
      }
      // A sane cap: ask for a longer range with a longer interval.
      if ((to.getTime() - from.getTime()) / span > MAX_BARS) {
        return { status: 400, body: { text: `at most ${MAX_BARS} ${interval} bars per request; narrow the range or widen the interval` } };
      }
      return { status: 200, body: { symbol, interval, bars: await bars(pool, symbol, interval, from, to) } };
    }
    if (url.pathname === "/trades") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (!symbols.includes(symbol)) return { status: 400, body: { text: "symbol: one of the listed tickers" } };
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRADES) {
        return { status: 400, body: { text: `limit: a whole number from 1 to ${MAX_TRADES}` } };
      }
      return { status: 200, body: { symbol, trades: await recentTrades(pool, symbol, limit) } };
    }
    return { status: 404, body: { text: "GET /history, GET /trades, GET /health, or WebSocket /live" } };
  } catch (error) {
    console.error(`api: ${path}: ${(error as Error).message}`);
    return { status: 500, body: { text: "internal error" } };
  }
}

// Writing and rolling up run one at a time on one chain: the rollup's watermark relies on it.
let chain: Promise<unknown> = Promise.resolve();
function serial(work: () => Promise<void>): void {
  chain = chain.then(work).catch((e: Error) => console.error(`store: ${e.message}`));
}

async function flush(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const stored = await insertTicks(pool, batch);
  stats.stored += stored;
  stats.duplicates += batch.length - stored;
}

const flusher = setInterval(() => serial(flush), FLUSH_EVERY_MS);
const roller = setInterval(() => serial(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    stats.rolledUp += await rollup(client, dayRoll);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}), ROLLUP_EVERY_MS);

const port = Number(process.env.MD_PORT ?? 8081);
http.listen(port, () => console.log(`market-data: http://127.0.0.1:${port}/history, ws://127.0.0.1:${port}/live`));
subscriber.start();

async function shutdown(): Promise<void> {
  console.log("market-data: shutting down");
  clearInterval(flusher);
  clearInterval(roller);
  subscriber.stop();
  fanout.close();
  http.close();
  serial(flush); // what was received is stored before exiting
  await chain;
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
