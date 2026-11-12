// A newswire for the synthetic market. It invents headlines about the companies Alpha
// Exchange lists and publishes them to anyone who subscribes: the simulator trades on them,
// the broker shows them. ADR 0006 explains why it exists; spec/README.md is its protocol.
//
//     pnpm start
//
// Needs nothing else running. Configuration is by environment variable (src/config.ts).

import { loadConfig } from "./config.ts";
import { Rng } from "./rng.ts";
import { Schedule } from "./schedule.ts";
import { createWireServer } from "./server.ts";
import { Wire } from "./wire.ts";

const STEP_MS = 1000;
const REPORT_MS = 60_000;

const config = loadConfig();
const wire = new Wire();
const schedule = new Schedule(config.companies, config.rate, new Rng(config.seed));
const server = createWireServer(wire);

let published = 0;
wire.listen((h) => {
  published += 1;
  console.log(`news: ${h.symbol} ${h.tone} ${h.severity} ${h.headline}`);
});

server.http.listen(config.port, () => {
  console.log(
    `newswire on :${config.port}: ${config.companies.length} companies, rate ${config.rate}, seed ${config.seed}`,
  );
});

let last = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  for (const story of schedule.step((now - last) / 1000, new Date(now))) wire.publish(story, now);
  last = now;
}, STEP_MS);

const reporter = setInterval(() => {
  console.log(`newswire: ${published} headline(s) published, ${server.clients()} client(s)`);
}, REPORT_MS);

function stop(): void {
  clearInterval(timer);
  clearInterval(reporter);
  void server.close().then(() => process.exit(0));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
