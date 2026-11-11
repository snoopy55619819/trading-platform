import assert from "node:assert/strict";
import { test } from "node:test";

import { Decoder, FixMessage, encode, formatCents, parseCents } from "../src/fix/codec.ts";
import { MsgType, Tag } from "../src/fix/tags.ts";

const header = { sender: "SIM", target: "ALPHA", seq: 7, sendingTime: "20261111-14:32:11.123" };

test("a message survives an encode and decode round trip", () => {
  const order = new FixMessage(MsgType.NewOrderSingle)
    .set(Tag.ClOrdID, "abc-1")
    .set(Tag.Symbol, "ACME")
    .set(Tag.Price, "42.10");
  const decoder = new Decoder();
  decoder.push(encode(order, header));
  const frame = decoder.next();
  assert.equal(frame?.kind, "message");
  if (frame?.kind !== "message") return;
  assert.equal(frame.seq, 7);
  assert.equal(frame.message.type, "D");
  assert.equal(frame.message.get(Tag.Price), "42.10");
  assert.equal(frame.message.get(Tag.SenderCompID), "SIM");
  assert.equal(decoder.next(), undefined);
});

test("BodyLength and CheckSum match a hand-computed frame", () => {
  const bytes = encode(new FixMessage(MsgType.Heartbeat), { ...header, seq: 1 });
  const text = bytes.toString("latin1").replaceAll("\x01", "|");
  const body = "35=0|49=SIM|56=ALPHA|34=1|52=20261111-14:32:11.123|";
  assert.ok(text.startsWith(`8=FIX.4.4|9=${body.length}|${body}10=`));
  let sum = 0;
  for (const byte of bytes.subarray(0, bytes.length - 7)) sum += byte;
  assert.ok(text.endsWith(`10=${String(sum % 256).padStart(3, "0")}|`));
});

test("frames split across reads and run together both decode", () => {
  const one = encode(new FixMessage(MsgType.Heartbeat), { ...header, seq: 1 });
  const two = encode(new FixMessage(MsgType.Heartbeat), { ...header, seq: 2 });
  const stream = Buffer.concat([one, two]);
  const decoder = new Decoder();
  decoder.push(stream.subarray(0, 10));
  assert.equal(decoder.next(), undefined);
  decoder.push(stream.subarray(10));
  const seqs = [decoder.next(), decoder.next()].map((f) => (f?.kind === "message" ? f.seq : -1));
  assert.deepEqual(seqs, [1, 2]);
});

test("a corrupted checksum is reported, and the next frame still decodes", () => {
  const bad = encode(new FixMessage(MsgType.Heartbeat), { ...header, seq: 1 });
  bad[bad.length - 2] = bad[bad.length - 2] === 0x30 ? 0x31 : 0x30;
  const good = encode(new FixMessage(MsgType.Heartbeat), { ...header, seq: 2 });
  const decoder = new Decoder();
  decoder.push(Buffer.concat([bad, good]));
  assert.equal(decoder.next()?.kind, "garbled");
  const next = decoder.next();
  assert.ok(next?.kind === "message" && next.seq === 2);
});

test("prices convert between FIX text and integer cents exactly", () => {
  assert.equal(formatCents(4210), "42.10");
  assert.equal(formatCents(5), "0.05");
  assert.equal(formatCents(-51), "-0.51");
  assert.equal(parseCents("42.1"), 4210);
  assert.equal(parseCents("42"), 4200);
  assert.equal(parseCents("-0.51"), -51);
  assert.equal(parseCents("286.55"), 28655);
  assert.throws(() => parseCents("4e2"));
});
