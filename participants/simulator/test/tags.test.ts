// Every tag number and message type the initiator uses must match the venue's published
// dictionary. Reads our vendored copy: the spec, not the exchange's code.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { MsgType, Tag } from "../src/fix/tags.ts";

const xml = readFileSync(new URL("../vendor/exchange-alpha/fix44.xml", import.meta.url), "utf8");

test("every tag we use has that number and name in fix44.xml", () => {
  const published = new Map<string, number>();
  for (const [, number, name] of xml.matchAll(/<field number="(\d+)"\s+name="(\w+)"/g)) {
    published.set(name!, Number(number));
  }
  for (const [name, number] of Object.entries(Tag)) {
    assert.equal(published.get(name), number, `${name}`);
  }
});

test("every message type we use is in fix44.xml under that name", () => {
  const published = new Map<string, string>();
  for (const [, name, type] of xml.matchAll(/<message name="(\w+)" msgtype="(\w+)"/g)) {
    published.set(name!, type!);
  }
  for (const [name, type] of Object.entries(MsgType)) {
    assert.equal(published.get(name), type, `${name}`);
  }
});
