// The load test (ADR 0012, docs/SCALE-PLAN.md stage 1): runs the whole stack locally and
// steps the simulator's load up until something gives, then says how many transactions a
// second the platform handled, and what stopped it.
//
//     pnpm db:up && pnpm exchange:db       the three Postgres containers
//     pnpm load-test                       steps 4, 8, 16, ... until something gives
//     pnpm load-test --steps 4,8 --secs 30 --label quick
//     pnpm load-test --max-ack-ms 1000         keep going past slow answers, to find the ceiling
//     pnpm load-test --steps 16:1,16:20,16:60  activity:quote activity (SIM_QUOTE_ACTIVITY,
//                                              1 if left out): trades and book churn apart
//
// A transaction is a new order or a cancel the exchange accepted: counted exactly, from the
// lines its journal gained during each step. The simulator holds the time of day at New
// York market hours (SIM_FLAT_DAY) and its own rate cap is lifted, so each step differs
// only in activity. Every process is started here, so its CPU time can be read: CPU is
// reported in cores (1.0 is one core fully busy). The databases run in Docker; their CPU
// comes from their containers.
//
// A step fails, and the test stops, at the first of:
//   - a single-threaded process (the gateway's core, any Node service) at 90% of a core;
//   - the exchange accepting fewer than 90% of what the simulator sent (falling behind);
//   - an order rejected, or a gap in the market data feed;
//   - no cancels at all: the market makers have stopped keeping their quotes up;
//   - the 99th percentile of order to first answer over 50 ms (the median of the
//     simulator's 5-second figures, so one stray window does not decide it).
// A load generator that cannot keep up shows as the simulator at 90% of a core.
//
// Results go to load-test/results/<date>-<label>.json; process logs to load-test/logs/.

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = new URL("..", import.meta.url).pathname;
const { values: args } = parseArgs({
  options: {
    steps: { type: "string", default: "4,8,16,32,64,128,256,512" },
    secs: { type: "string", default: "60" },
    warmup: { type: "string", default: "15" },
    label: { type: "string", default: "local" },
    "max-ack-ms": { type: "string", default: "50" },
  },
});
const STEPS = args.steps.split(",").map((step) => {
  const [activity, quotes] = step.split(":").map(Number);
  return { activity: activity!, quoteActivity: quotes ?? 1 };
});
const MEASURE_SECS = Number(args.secs);
const WARMUP_SECS = Number(args.warmup);

const LIMITS = {
  core: 0.9,
  accepted: 0.9,
  ackP99Ms: Number(args["max-ack-ms"]),
};

const LOGS = join(ROOT, "load-test/logs");
const RESULTS = join(ROOT, "load-test/results");
// A fresh exchange every run: an empty book, and a journal holding only this run.
const JOURNALS = join(LOGS, "exchange-data");
const SIM_STATE = join(LOGS, "sim-open-orders.json");
rmSync(JOURNALS, { recursive: true, force: true });
rmSync(SIM_STATE, { force: true });
mkdirSync(JOURNALS, { recursive: true });
mkdirSync(LOGS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- processes ----

interface Service {
  name: string;
  child: ChildProcess;
  output: string[];
}

function start(name: string, cwd: string, command: string, argv: string[], env: Record<string, string> = {}): Service {
  const log = createWriteStream(join(LOGS, `${name}.log`));
  const child = spawn(command, argv, { cwd: join(ROOT, cwd), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  const keep = (chunk: Buffer) => {
    log.write(chunk);
    for (const line of chunk.toString().split("\n")) if (line) output.push(line);
    if (output.length > 2000) output.splice(0, output.length - 1000);
  };
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  child.on("exit", (code) => {
    if (!stopping.has(name)) console.error(`${name} exited (${code}); see load-test/logs/${name}.log`);
  });
  return { name, child, output };
}

const stopping = new Set<string>();
async function stop(service: Service): Promise<void> {
  stopping.add(service.name);
  if (service.child.exitCode !== null) return;
  const exited = new Promise((resolve) => service.child.once("exit", resolve));
  service.child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (service.child.exitCode === null) service.child.kill("SIGKILL");
  stopping.delete(service.name);
}

async function waitFor(service: Service, pattern: RegExp, secs: number): Promise<void> {
  for (let i = 0; i < secs * 10; i++) {
    if (service.output.some((line) => pattern.test(line))) return;
    if (service.child.exitCode !== null) throw new Error(`${service.name} exited; see load-test/logs/${service.name}.log`);
    await sleep(100);
  }
  throw new Error(`${service.name} did not print ${pattern} within ${secs}s`);
}

/** Seconds of CPU a process has used, from `ps` (`[[h:]m:]s.cs`). */
function cpuSecs(pid: number): number {
  const out = execFileSync("ps", ["-o", "time=", "-p", String(pid)]).toString().trim();
  return out.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function rssMb(pid: number): number {
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024;
}

// ---- databases (Docker) ----

const CONTAINERS = ["exchange-alpha-postgres", "broker-market-data-postgres", "broker-postgres"];

function containerCpuSecs(name: string): number {
  const stat = execFileSync("docker", ["exec", name, "cat", "/sys/fs/cgroup/cpu.stat"]).toString();
  return Number(/usage_usec (\d+)/.exec(stat)![1]) / 1e6;
}

function containerMb(name: string): number {
  return Number(execFileSync("docker", ["exec", name, "cat", "/sys/fs/cgroup/memory.current"]).toString()) / 2 ** 20;
}

function sql(container: string, user: string, query: string): number {
  const out = execFileSync("docker", ["exec", container, "psql", "-U", user, user, "-Atc", query]).toString().trim();
  return Number(out || 0);
}

const sentByExchange = () => sql("exchange-alpha-postgres", "exchange_alpha", "select coalesce(max(seq), 0) from fix_outbound where comp_id = 'SIM'");
const trades = (from: number, to: number) =>
  sql("broker-market-data-postgres", "market_data", `select count(*) from ticks where ts >= to_timestamp(${from / 1000}) and ts < to_timestamp(${to / 1000})`);
/** Feed messages between the first and last trade in the window, from their `feed_seq`. */
const feedMessages = (from: number, to: number) =>
  sql("broker-market-data-postgres", "market_data", `select coalesce(max(feed_seq) - min(feed_seq), 0) from ticks where ts >= to_timestamp(${from / 1000}) and ts < to_timestamp(${to / 1000})`);

// ---- the journal ----

function currentJournal(): string {
  const files = readdirSync(JOURNALS).filter((f) => f.endsWith(".journal"));
  const seq = (f: string) => Number(/\.(\d+)\.journal$/.exec(f)?.[1] ?? 0);
  files.sort((a, b) => seq(a) - seq(b));
  if (files.length === 0) throw new Error(`no journal in ${JOURNALS}`);
  return join(JOURNALS, files.at(-1)!);
}

/** New orders and cancels the journal gained after `from` bytes. */
function countTransactions(path: string, from: number): { news: number; cancels: number } {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(size - from);
  readSync(fd, buffer, 0, buffer.length, from);
  closeSync(fd);
  const text = buffer.toString();
  return { news: text.split('"type":"NEW"').length - 1, cancels: text.split('"type":"CANCEL"').length - 1 };
}

// ---- the simulator's status line ----

interface SimStatus {
  orders: number;
  cancels: number;
  fills: number;
  rejects: number;
  gaps: number;
  ack?: { p50: number; p99: number };
}

const STATUS = /orders (\d+), cancels (\d+), fills (\d+), rejects (\d+), throttled \d+, feed gaps (\d+).*?(?:ack p50 ([\d.]+) ms p99 ([\d.]+) ms)?$/;

function statuses(sim: Service): SimStatus[] {
  return sim.output.flatMap((line) => {
    const m = STATUS.exec(line);
    if (!m) return [];
    const status: SimStatus = { orders: +m[1]!, cancels: +m[2]!, fills: +m[3]!, rejects: +m[4]!, gaps: +m[5]! };
    if (m[6]) status.ack = { p50: +m[6], p99: +m[7]! };
    return [status];
  });
}

/**
 * The market's shape from the simulator's last status table: the median spread across
 * symbols, in basis points of fair value, and how many symbols had a side of the book empty.
 */
function bookShape(sim: Service): { spreadBps: number; emptySides: number } | null {
  const lines = sim.output;
  const last = lines.findLastIndex((line) => STATUS.test(line));
  const spreads: number[] = [];
  let emptySides = 0;
  for (const line of lines.slice(Math.max(0, last - 14), last)) {
    const m = /^\s*[A-Z]{2,}\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(\S+)\s/.exec(line);
    if (!m) continue;
    if (m[2] === "-" || m[3] === "-") emptySides += 1;
    else spreads.push((Number(m[4]) / Number(m[1])) * 10_000);
  }
  if (spreads.length === 0 && emptySides === 0) return null;
  spreads.sort((a, b) => a - b);
  return { spreadBps: spreads[Math.floor(spreads.length / 2)] ?? 0, emptySides };
}

// ---- a step ----

interface Step {
  activity: number;
  quoteActivity: number;
  transactionsPerSec: number;
  newOrdersPerSec: number;
  cancelsPerSec: number;
  simulatorSentPerSec: number;
  tradesPerSec: number;
  executionReportsPerSec: number;
  feedMessagesPerSec: number;
  ackMs: { p50: number; p99: number } | null;
  /** Median spread across symbols at the end of the step, and symbols with a side empty. */
  book: { spreadBps: number; emptySides: number } | null;
  rejects: number;
  feedGaps: number;
  cpuCores: Record<string, number>;
  memoryMb: Record<string, number>;
  failed: string[];
}

async function runStep(activity: number, quoteActivity: number, services: Service[]): Promise<Step> {
  const sim = start("simulator", "participants/simulator", "node", ["src/main.ts"], {
    SIM_ACTIVITY: String(activity),
    SIM_QUOTE_ACTIVITY: String(quoteActivity),
    SIM_FLAT_DAY: "1",
    SIM_MAX_ORDERS_PER_SEC: "1000000",
    SIM_REPORT_SECS: "5",
    SIM_STATE_FILE: SIM_STATE,
  });
  await waitFor(sim, /logged on/, 30);
  await sleep(WARMUP_SECS * 1000);

  const all = [...services, sim];
  const journal = currentJournal();
  const before = {
    at: Date.now(),
    bytes: statSync(journal).size,
    cpu: Object.fromEntries(all.map((s) => [s.name, cpuSecs(s.child.pid!)])),
    db: Object.fromEntries(CONTAINERS.map((c) => [c, containerCpuSecs(c)])),
    reports: sentByExchange(),
    status: statuses(sim).at(-1)!,
    lines: statuses(sim).length,
  };
  await sleep(MEASURE_SECS * 1000);
  const at = Date.now();
  const secs = (at - before.at) / 1000;
  const tx = countTransactions(journal, before.bytes);
  const cpu = Object.fromEntries(all.map((s) => [s.name, (cpuSecs(s.child.pid!) - before.cpu[s.name]!) / secs]));
  for (const c of CONTAINERS) cpu[c] = (containerCpuSecs(c) - before.db[c]!) / secs;
  const memory = Object.fromEntries(all.map((s) => [s.name, rssMb(s.child.pid!)]));
  for (const c of CONTAINERS) memory[c] = containerMb(c);
  const reports = (sentByExchange() - before.reports) / secs;
  await sleep(2000); // market-data writes trades in batches
  const tradeCount = trades(before.at, at);
  const feed = feedMessages(before.at, at) / secs;
  const window = statuses(sim).slice(before.lines);
  const after = window.at(-1) ?? before.status;
  const book = bookShape(sim);
  await stop(sim);

  const acks = window.flatMap((s) => (s.ack ? [s.ack] : []));
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  // The simulator reports both every 5 s; the step's are the medians of those.
  const ackMs = acks.length ? { p50: median(acks.map((a) => a.p50)), p99: median(acks.map((a) => a.p99)) } : null;
  const simulatorSent = (after.orders + after.cancels - before.status.orders - before.status.cancels) / secs;
  const transactions = (tx.news + tx.cancels) / secs;

  const failed: string[] = [];
  for (const [name, cores] of Object.entries(cpu)) {
    if (!CONTAINERS.includes(name) && cores >= LIMITS.core) failed.push(`${name} at ${(cores * 100).toFixed(0)}% of a core`);
  }
  if (transactions < simulatorSent * LIMITS.accepted) {
    failed.push(`exchange accepted ${transactions.toFixed(0)}/s of ${simulatorSent.toFixed(0)}/s sent`);
  }
  if (after.rejects > before.status.rejects) failed.push(`${after.rejects - before.status.rejects} orders rejected`);
  if (tx.cancels === 0) failed.push("no cancels: the market makers stopped re-quoting");
  if (after.gaps > before.status.gaps) failed.push(`${after.gaps - before.status.gaps} feed gaps`);
  if (ackMs && ackMs.p99 > LIMITS.ackP99Ms) failed.push(`order to answer p99 ${ackMs.p99.toFixed(1)} ms`);

  return {
    activity,
    quoteActivity,
    transactionsPerSec: round(transactions),
    newOrdersPerSec: round(tx.news / secs),
    cancelsPerSec: round(tx.cancels / secs),
    simulatorSentPerSec: round(simulatorSent),
    tradesPerSec: round(tradeCount / secs),
    executionReportsPerSec: round(reports),
    feedMessagesPerSec: round(feed),
    ackMs: ackMs && { p50: round(ackMs.p50, 2), p99: round(ackMs.p99, 2) },
    book: book && { spreadBps: round(book.spreadBps), emptySides: book.emptySides },
    rejects: after.rejects - before.status.rejects,
    feedGaps: after.gaps - before.status.gaps,
    cpuCores: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, round(v, 3)])),
    memoryMb: Object.fromEntries(Object.entries(memory).map(([k, v]) => [k, round(v)])),
    failed,
  };
}

const round = (x: number, places = 1) => Math.round(x * 10 ** places) / 10 ** places;

function print(step: Step): void {
  const top = Object.entries(step.cpuCores).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(
    `activity ${String(step.activity).padStart(4)}, quotes ${String(step.quoteActivity).padStart(3)}: ${String(step.transactionsPerSec).padStart(7)} tx/s ` +
      `(${step.newOrdersPerSec} new, ${step.cancelsPerSec} cancel), ${step.tradesPerSec} trades/s, ` +
      `${step.executionReportsPerSec} reports/s, spread ${step.book ? `${step.book.spreadBps} bps${step.book.emptySides ? ` (${step.book.emptySides} one-sided)` : ""}` : "-"}, ack p50/p99 ${step.ackMs ? `${step.ackMs.p50}/${step.ackMs.p99} ms` : "-"}; ` +
      `busiest ${top.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}` +
      (step.failed.length ? `\n  STOP: ${step.failed.join("; ")}` : ""),
  );
}

// ---- main ----

async function main(): Promise<void> {
  const build = spawnSync("cargo", ["build", "--release", "-p", "gateway"], { cwd: join(ROOT, "exchange-alpha"), stdio: "inherit" });
  if (build.status !== 0) throw new Error("cargo build --release -p gateway failed");

  const gateway = start("gateway", "exchange-alpha", "target/release/gateway", [], { RUST_LOG: "info,sqlx=warn", ALPHA_DATA_DIR: JOURNALS });
  await waitFor(gateway, /Alpha Exchange open/, 120);
  const services = [
    gateway,
    start("market-data", "broker/market-data", "node", ["src/main.ts"]),
    start("backend", "broker/backend", "node", ["src/main.ts"]),
    start("newswire", "participants/newswire", "node", ["src/main.ts"]),
  ];
  await sleep(3000);

  const steps: Step[] = [];
  let stopReason = "every step passed";
  try {
    for (const { activity, quoteActivity } of STEPS) {
      const step = await runStep(activity, quoteActivity, services);
      print(step);
      steps.push(step);
      if (step.failed.length) {
        stopReason = step.failed.join("; ");
        break;
      }
    }
  } finally {
    for (const service of services.reverse()) await stop(service);
  }

  const passed = steps.filter((s) => s.failed.length === 0);
  const best = passed.at(-1);
  const verdict = best
    ? `handles ${best.transactionsPerSec} transactions a second (activity ${best.activity}, quotes ${best.quoteActivity}); next step stopped by: ${stopReason}`
    : `the first step failed: ${stopReason}`;
  console.log(`\n${verdict}`);

  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
  const result = {
    at: new Date().toISOString(),
    commit: sha,
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) },
    measureSecs: MEASURE_SECS,
    warmupSecs: WARMUP_SECS,
    limits: LIMITS,
    verdict,
    steps,
  };
  const file = join(RESULTS, `${new Date().toISOString().slice(0, 10)}-${args.label}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`saved ${file}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
