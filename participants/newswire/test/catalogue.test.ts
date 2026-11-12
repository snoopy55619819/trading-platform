// Every story the wire can write: well formed, matching the published spec, fitting the
// company it is about, and with a body that says what the headline says.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CATALOGUE, CATEGORIES, SEVERITIES, TONES, pickCategory, quarterReported, weightFor, write } from "../src/catalogue.ts";
import { Rng } from "../src/rng.ts";

const spec = JSON.parse(readFileSync(new URL("../spec/newswire.json", import.meta.url), "utf8")) as {
  categories: Record<string, string>;
};
const LONGEST_NAME = "Ionex Chemical Holdings Incorporated";
const acme = { ticker: "ACME", name: "Acme Industrial Corp", referenceCents: 4210 };
const helx = { ticker: "HELX", name: "Helix Biosciences Inc", referenceCents: 725 };

type Wording = { headline: string; body: unknown };
const wordings = (category: (typeof CATEGORIES)[number]): Wording[] => {
  const kind: { minor: readonly Wording[]; major?: readonly Wording[] } = CATALOGUE[category];
  return [...kind.minor, ...(kind.major ?? [])];
};

test("the published spec lists every category with its tone, and nothing else", () => {
  assert.deepEqual(spec.categories, Object.fromEntries(CATEGORIES.map((c) => [c, CATALOGUE[c].tone])));
});

test("every headline names the company, is one line, and fits the schema", () => {
  for (const category of CATEGORIES) {
    const kind: { tone: string; major?: unknown } = CATALOGUE[category];
    assert.ok(TONES.includes(kind.tone as (typeof TONES)[number]), category);
    assert.equal(kind.major === undefined, kind.tone === "NEUTRAL", `${category}: only moving stories have a MAJOR wording`);
    for (const { headline } of wordings(category)) {
      assert.ok(headline.includes("{name}"), headline);
      assert.ok(!headline.endsWith("."), `${headline}: no trailing full stop`);
      assert.ok(!headline.includes("\u2014"), `${headline}: no em dash`);
      assert.ok(headline.replace("{name}", LONGEST_NAME).length <= 160, headline);
    }
  }
});

test("every story is a few full sentences about the company, within the schema's limit", () => {
  const rng = new Rng(11);
  for (const category of CATEGORIES) {
    for (const severity of SEVERITIES) {
      for (const company of [acme, helx]) {
        for (let i = 0; i < 20; i++) {
          const { headline, body } = write(category, severity, company, rng, new Date("2026-11-12T12:00:00Z"));
          assert.ok(body.length >= 40 && body.length <= 1000, `${category}: ${body.length} characters`);
          assert.ok(body.includes(company.name.split(" ")[0]!), `${category}: ${body}`);
          assert.ok(/[.!?"]$/.test(body), `${category}: ends a sentence: ${body}`);
          assert.ok(!body.includes("\u2014") && !body.includes("undefined") && !body.includes("NaN"), body);
          assert.ok(headline.length > 0);
        }
      }
    }
  }
});

test("a headline always comes with its own story", () => {
  // The two minor wordings of a new appointment are different jobs: the story must match.
  const rng = new Rng(12);
  for (let i = 0; i < 50; i++) {
    const { headline, body } = write("EXECUTIVE_APPOINTED", "MINOR", acme, rng);
    assert.equal(headline.includes("investor relations"), body.includes("investor relations"), `${headline} / ${body}`);
  }
});

test("MAJOR stories carry bigger numbers: a major earnings miss misses by more", () => {
  const rng = new Rng(13);
  const gap = (severity: "MINOR" | "MAJOR") => {
    const { body } = write("EARNINGS_MISS", severity, acme, rng);
    const [actual, expected] = [...body.matchAll(/\$(\d+\.\d\d)/g)].map((m) => Number(m[1]));
    return (expected! - actual!) / expected!;
  };
  for (let i = 0; i < 100; i++) {
    const minor = gap("MINOR");
    const major = gap("MAJOR");
    // 2 to 6% and 12 to 30%, give or take rounding to the cent in the text.
    assert.ok(minor > 0.01 && minor < 0.08, `minor miss ${minor}`);
    assert.ok(major > 0.1 && major < 0.33, `major miss ${major}`);
  }
});

test("earnings stories report the quarter just finished", () => {
  assert.equal(quarterReported(new Date("2026-11-12T00:00:00Z")), "third-quarter");
  assert.equal(quarterReported(new Date("2026-02-01T00:00:00Z")), "fourth-quarter");
  const { body } = write("EARNINGS_BEAT", "MINOR", acme, new Rng(1), new Date("2026-05-01T00:00:00Z"));
  assert.match(body, /first-quarter earnings/);
});

test("a category always has the tone asked for, and fits the company", () => {
  const rng = new Rng(7);
  const counts = new Map<string, number>();
  for (let i = 0; i < 5000; i++) {
    for (const tone of TONES) assert.equal(CATALOGUE[pickCategory("ACME", tone, rng)].tone, tone);
    const story = pickCategory("HELX", "POSITIVE", rng);
    counts.set(story, (counts.get(story) ?? 0) + 1);
  }
  // An industrial has no products awaiting approval; the biotech has the most.
  assert.equal(weightFor("ACME", "PRODUCT_APPROVAL"), 0);
  const approvals = counts.get("PRODUCT_APPROVAL") ?? 0;
  assert.ok(approvals > (counts.get("BUYBACK") ?? 0) * 2, `HELX approvals: ${approvals}`);
});
