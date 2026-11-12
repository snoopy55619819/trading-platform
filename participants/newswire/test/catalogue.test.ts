// Every story the wire can write: well formed, matching the published spec, and fitting the
// company it is about.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CATALOGUE, CATEGORIES, TONES, pickCategory, weightFor, write } from "../src/catalogue.ts";
import { Rng } from "../src/rng.ts";

const spec = JSON.parse(readFileSync(new URL("../spec/newswire.json", import.meta.url), "utf8")) as {
  categories: Record<string, string>;
};
const LONGEST_NAME = "Ionex Chemical Holdings Incorporated";

test("the published spec lists every category with its tone, and nothing else", () => {
  assert.deepEqual(spec.categories, Object.fromEntries(CATEGORIES.map((c) => [c, CATALOGUE[c].tone])));
});

test("every wording names the company, is one line, and fits the schema", () => {
  for (const category of CATEGORIES) {
    const kind: { tone: string; minor: readonly string[]; major?: readonly string[] } = CATALOGUE[category];
    assert.ok(TONES.includes(kind.tone as (typeof TONES)[number]), category);
    assert.equal(kind.major === undefined, kind.tone === "NEUTRAL", `${category}: only moving stories have a MAJOR wording`);
    for (const wording of [...kind.minor, ...(kind.major ?? [])]) {
      assert.ok(wording.includes("{name}"), wording);
      assert.ok(!wording.endsWith("."), `${wording}: no trailing full stop`);
      assert.ok(!wording.includes("—"), `${wording}: no em dash`);
      assert.ok(wording.replace("{name}", LONGEST_NAME).length <= 160, wording);
    }
  }
});

test("MAJOR news gets the stronger wording; neutral news only has one strength", () => {
  const rng = new Rng(1);
  const major = write("EARNINGS_MISS", "MAJOR", "Acme Industrial Corp", rng);
  assert.ok(CATALOGUE.EARNINGS_MISS.major.map((w) => w.replace("{name}", "Acme Industrial Corp")).includes(major));
  const neutral = write("CONFERENCE", "MAJOR", "Acme Industrial Corp", rng);
  assert.ok(CATALOGUE.CONFERENCE.minor.map((w) => w.replace("{name}", "Acme Industrial Corp")).includes(neutral));
});

test("a category always has the tone asked for, and fits the company", () => {
  const rng = new Rng(7);
  const counts = new Map<string, number>();
  for (let i = 0; i < 5000; i++) {
    for (const tone of TONES) assert.equal(CATALOGUE[pickCategory("ACME", tone, rng)].tone, tone);
    const helx = pickCategory("HELX", "POSITIVE", rng);
    counts.set(helx, (counts.get(helx) ?? 0) + 1);
  }
  // An industrial has no products awaiting approval; the biotech has the most.
  assert.equal(weightFor("ACME", "PRODUCT_APPROVAL"), 0);
  const approvals = counts.get("PRODUCT_APPROVAL") ?? 0;
  assert.ok(approvals > (counts.get("BUYBACK") ?? 0) * 2, `HELX approvals: ${approvals}`);
});
