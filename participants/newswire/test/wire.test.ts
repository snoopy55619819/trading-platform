// The wire: stamping, catch-up, the size of its memory, and the published shape over HTTP
// and the WebSocket.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { WebSocket } from "ws";

import { companiesFrom } from "../src/config.ts";
import { createWireServer } from "../src/server.ts";
import { type Headline, Wire } from "../src/wire.ts";

const story = (symbol = "ACME") => ({
  symbol,
  headline: "Acme Industrial Corp edges past quarterly estimates",
  category: "EARNINGS_BEAT" as const,
  tone: "POSITIVE" as const,
  severity: "MINOR" as const,
});

const schema = JSON.parse(readFileSync(new URL("../spec/headline.schema.json", import.meta.url), "utf8")) as {
  required: string[];
  properties: Record<string, { pattern?: string; enum?: string[] }>;
};

/** The checks the schema states, without a JSON Schema library. */
function assertMatchesSchema(h: Headline): void {
  assert.deepEqual(Object.keys(h).sort(), [...schema.required].sort());
  for (const [field, rule] of Object.entries(schema.properties)) {
    const value = h[field as keyof Headline];
    if (rule.pattern) assert.match(value, new RegExp(rule.pattern), field);
    if (rule.enum) assert.ok(rule.enum.includes(value), `${field}: ${value}`);
  }
  assert.equal(new Date(h.ts).toISOString(), h.ts);
}

test("a published headline has an id, a time, and the story", () => {
  const wire = new Wire();
  const h = wire.publish(story(), Date.parse("2026-11-12T14:03:12.481Z"));
  assert.equal(h.ts, "2026-11-12T14:03:12.481Z");
  assertMatchesSchema(h);
});

test("catch-up is inclusive of the time asked for, oldest first", () => {
  const wire = new Wire();
  const t = Date.parse("2026-11-12T14:00:00.000Z");
  const a = wire.publish(story("ACME"), t);
  const b = wire.publish(story("BLTZ"), t); // the same millisecond
  const c = wire.publish(story("CRUX"), t + 1);
  assert.deepEqual(wire.since(new Date(t)).map((h) => h.id), [a.id, b.id, c.id]);
  assert.deepEqual(wire.since(new Date(t + 1)).map((h) => h.id), [c.id]);
  assert.deepEqual(wire.since(new Date(t + 2)), []);
});

test("only the newest are kept", () => {
  const wire = new Wire(3);
  for (let i = 0; i < 5; i++) wire.publish(story(), 1000 + i);
  assert.deepEqual(wire.since(new Date(0)).map((h) => h.ts), [1002, 1003, 1004].map((t) => new Date(t).toISOString()));
});

test("companies come from the exchange's active listings", () => {
  const listings = JSON.parse(
    readFileSync(new URL("../vendor/exchange-alpha/listings.json", import.meta.url), "utf8"),
  ) as Parameters<typeof companiesFrom>[0];
  const companies = companiesFrom(listings);
  assert.equal(companies.length, 10);
  assert.deepEqual(companies[0], { ticker: "ACME", name: "Acme Industrial Corp" });
  assert.deepEqual(companiesFrom({ symbols: [{ ticker: "OLD", name: "Old Co", status: "HALTED" }] }), []);
});

test("over the network: live on the WebSocket, catch-up and health over HTTP", async () => {
  const wire = new Wire();
  const server = createWireServer(wire);
  await new Promise<void>((resolve) => server.http.listen(0, resolve));
  const base = `localhost:${(server.http.address() as AddressInfo).port}`;
  try {
    const before = new Date();
    const socket = new WebSocket(`ws://${base}/headlines`);
    await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
    const received = new Promise<Headline>((resolve) => socket.once("message", (data) => resolve(JSON.parse(String(data)))));
    const published = wire.publish(story());
    const live = await received;
    assert.deepEqual(live, published);
    assertMatchesSchema(live);

    const caughtUp = (await (await fetch(`http://${base}/headlines?since=${before.toISOString()}`)).json()) as { headlines: Headline[] };
    assert.deepEqual(caughtUp.headlines, [published]);
    assert.equal((await fetch(`http://${base}/headlines`)).status, 400);
    assert.equal((await fetch(`http://${base}/headlines?since=yesterday`)).status, 400);
    assert.equal((await fetch(`http://${base}/nothing`)).status, 404);
    assert.deepEqual(await (await fetch(`http://${base}/health`)).json(), { ok: true, clients: 1 });
    socket.close();
  } finally {
    await server.close();
  }
});
