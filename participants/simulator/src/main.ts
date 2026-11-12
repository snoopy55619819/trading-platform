// Alpha Exchange's simulated trading firms. One process, one FIX session, many desks.
//
//     pnpm start
//
// Needs the exchange running (FIX on 9878, market data on 9879; see the repo README).
// Configuration is by environment variable; see src/config.ts. Ctrl-C cancels every
// resting order and logs out. Once a day, at the venue's roll, it does the same and logs
// straight back on with fresh sequence numbers.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type Agent, type Context, Positions } from "./agents/context.ts";
import { MarketMaker } from "./agents/market-maker.ts";
import { MeanReversionTrader, MomentumTrader, NoiseTrader } from "./agents/takers.ts";
import { loadConfig, profileFor } from "./config.ts";
import { FeedClient } from "./feed/client.ts";
import { FixConnection } from "./fix/connection.ts";
import { nextSessionReset } from "./fix/daily-reset.ts";
import { diurnal } from "./market/diurnal.ts";
import { FairValue } from "./market/fair-value.ts";
import { Rng } from "./market/rng.ts";
import { Orders, RateLimit, type SavedOrder } from "./orders.ts";
import { report } from "./report.ts";

const STEP_MS = 250;

const config = loadConfig();
const rng = new Rng(config.seed);
const positions = new Positions();
const listings = new Map(config.listings.map((l) => [l.ticker, l]));
const fair = new Map(config.listings.map((l) => [l.ticker, new FairValue(l, profileFor(l.ticker), config.speed)]));

const fix = new FixConnection(
  config.fixHost,
  config.fixPort,
  { sender: config.compId, target: config.venue, heartbeatSecs: 10 },
  {
    onActive() {
      const cancelled = orders.cancelEverything(Date.now());
      console.log(`fix: logged on as ${config.compId}; cancelled ${cancelled} order(s) left from before`);
      saveOpenOrders();
    },
    onMessage(message) {
      orders.receive(message);
    },
    onDown(why) {
      console.warn(`fix: down (${why}); reconnecting`);
    },
  },
);
const orders = new Orders(
  (message) => {
    if (!fix.isActive()) return false;
    fix.send(message);
    return true;
  },
  new RateLimit(config.maxOrdersPerSec, Date.now()),
  (fill) => positions.apply(fill),
);
const feed = new FeedClient(config.feedUrl, [...listings.keys()], { onTrade() {} });

const context: Context = { listings, fair, feed, orders, positions, rng, activity: 1 };
const makers = config.listings.map((l) => new MarketMaker(l.ticker, context));
const agents: Agent[] = [
  ...makers,
  new NoiseTrader(context, config.activity),
  new MomentumTrader(context, config.activity),
  new MeanReversionTrader(context, config.activity),
];

// Orders a crashed run left resting are cancelled as soon as we log on.
try {
  const saved = JSON.parse(readFileSync(config.stateFile, "utf8")) as SavedOrder[];
  orders.adopt(saved);
  console.log(`state: ${saved.length} order(s) from a previous run will be cancelled`);
} catch {
  // No file: a clean start.
}

/** Written to a temporary file and renamed, so a crash mid-write never leaves half a file. */
function saveOpenOrders(): void {
  mkdirSync(dirname(config.stateFile), { recursive: true });
  const temporary = `${config.stateFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(orders.saved()));
  renameSync(temporary, config.stateFile);
}

let last = Date.now();
function step(): void {
  const now = Date.now();
  const dtSec = (now - last) / 1000;
  last = now;
  context.activity = diurnal(new Date(now));
  for (const value of fair.values()) value.step(dtSec, context.activity, rng);
  if (!fix.isActive() || resetting) return;
  for (const agent of agents) agent.step(now, dtSec);
}

// Once a day, at the venue's roll, the FIX session starts over (see fix/daily-reset.ts).
// Everything resting is cancelled first, so nothing can trade while we are away and no fill
// is lost when the exchange forgets what it would have resent. The makers quote again as
// soon as we are back.
let resetting = false;
let resetTimer: NodeJS.Timeout | undefined;
function scheduleSessionReset(): void {
  const at = nextSessionReset(Date.now(), config.sessionResetUtc, config.sessionResetEverySecs);
  resetTimer = setTimeout(() => void resetSession(), at - Date.now());
}
async function resetSession(): Promise<void> {
  resetting = true;
  const cancelled = orders.cancelEverything(Date.now());
  console.log(`fix: daily session reset; cancelled ${cancelled} resting order(s) first`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await fix.restart("daily session reset");
  resetting = false; // agents resume once the new session is active
  scheduleSessionReset();
}

console.log(
  `simulator: ${config.listings.length} symbols, spec ${config.specVersion}, seed ${config.seed}, ` +
    `up to ${config.maxOrdersPerSec} orders/s, activity x${config.activity}, speed x${config.speed}`,
);
fix.start();
feed.start();
scheduleSessionReset();
const stepper = setInterval(step, STEP_MS);
const saver = setInterval(saveOpenOrders, 1000);
const reporter = setInterval(
  () => console.log(report({ ...context, makers, gaps: feed.gaps })),
  config.reportSecs * 1000,
);

async function shutdown(): Promise<void> {
  clearInterval(stepper);
  clearInterval(reporter);
  clearTimeout(resetTimer);
  clearInterval(saver);
  const cancelled = orders.cancelEverything(Date.now());
  console.log(`simulator: stopping; cancelling ${cancelled} resting order(s)`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (orders.open().length === 0) rmSync(config.stateFile, { force: true });
  else saveOpenOrders();
  await fix.stop();
  feed.stop();
  console.log(report({ ...context, makers, gaps: feed.gaps }));
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
