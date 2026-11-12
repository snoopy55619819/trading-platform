import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Decoder, FixMessage, encode, formatCents, parseCents } from "../src/fix/codec.ts";
import { type Action, Session, type StoredMessage } from "../src/fix/session.ts";
import { MsgType, Tag } from "../src/fix/tags.ts";

const config = { sender: "BROKER", target: "ALPHA", heartbeatSecs: 30 };

function decode(bytes: Buffer) {
  const decoder = new Decoder();
  decoder.push(bytes);
  const frame = decoder.next();
  if (frame?.kind !== "message") throw new Error("not a message");
  return frame;
}

const sent = (actions: Action[]) =>
  actions.flatMap((a) => (a.kind === "send" ? [decode(a.bytes)] : []));

function incoming(type: string, seq: number, fields: [number, string][] = []) {
  const message = new FixMessage(type, fields);
  return decode(encode(message, { sender: "ALPHA", target: "BROKER", seq, sendingTime: "x" })).message;
}

test("every tag and message type matches the vendored dictionary", () => {
  const xml = readFileSync(new URL("../vendor/exchange-alpha/fix44.xml", import.meta.url), "utf8");
  const fields = new Map([...xml.matchAll(/<field number="(\d+)"\s+name="(\w+)"/g)].map((m) => [m[2], Number(m[1])]));
  for (const [name, number] of Object.entries(Tag)) assert.equal(fields.get(name), number, name);
  const messages = new Map([...xml.matchAll(/<message name="(\w+)" msgtype="(\w+)"/g)].map((m) => [m[1], m[2]]));
  for (const [name, type] of Object.entries(MsgType)) assert.equal(messages.get(name), type, name);
});

test("prices go to and from FIX as exact cents, and anything finer is refused", () => {
  assert.equal(formatCents(4210), "42.10");
  assert.equal(parseCents("42.1"), 4210);
  assert.equal(parseCents("42.1000"), 4210); // AvgPx-style trailing zeros
  assert.equal(parseCents("-0.84"), -84);
  assert.throws(() => parseCents("42.105"));
});

test("the very first logon asks for a reset; later ones keep their numbers", () => {
  const fresh = new Session(config);
  const [logon] = sent(fresh.connected(0));
  assert.equal(logon?.message.get(Tag.ResetSeqNumFlag), "Y");
  assert.equal(logon?.seq, 1);

  const resumed = new Session(config, { nextOut: 40, nextIn: 70 });
  const [again] = sent(resumed.connected(0));
  assert.equal(again?.message.get(Tag.ResetSeqNumFlag), undefined);
  assert.equal(again?.seq, 40);
});

test("the session remembers when the exchange last sent anything", () => {
  const session = new Session(config);
  session.connected(1000);
  assert.equal(session.lastHeardAt(), undefined, "connecting is not hearing from it");
  session.receive(incoming(MsgType.Logon, 1), 1, 2000);
  session.receive(incoming(MsgType.Heartbeat, 2), 2, 5000);
  assert.equal(session.lastHeardAt(), 5000);
  session.disconnected();
  assert.equal(session.lastHeardAt(), 5000, "kept after a disconnect, so a dead link shows how long ago");
});

test("a logon reply ahead of us logs on, then asks for what was missed", () => {
  const session = new Session(config, { nextOut: 40, nextIn: 70 });
  session.connected(0);
  const actions = session.receive(incoming(MsgType.Logon, 73), 73, 0);
  assert.deepEqual(actions.slice(0, 2), [{ kind: "active" }, { kind: "gap", from: 70, received: 73 }]);
  const [request] = sent(actions);
  assert.equal(request?.message.type, MsgType.ResendRequest);
  assert.equal(request?.message.get(Tag.BeginSeqNo), "70");
  assert.equal(session.isActive(), true);

  // The resent report arrives with PossDup and is delivered in order.
  const resent = incoming(MsgType.ExecutionReport, 70, [[Tag.PossDupFlag, "Y"]]);
  assert.equal(session.receive(resent, 70, 0)[0]?.kind, "deliver");
  assert.equal(session.sequence()?.nextIn, 71);
});

test("a resend request is answered with the stored orders and gap fills between them", () => {
  const session = new Session(config, { nextOut: 10, nextIn: 5 });
  session.connected(0); // the Logon is 10
  session.receive(incoming(MsgType.Logon, 5), 5, 0);
  const stored: StoredMessage[] = [
    { seq: 12, type: MsgType.NewOrderSingle, fields: [[Tag.ClOrdID, "order-a"]], sentAt: new Date(1_000) },
    { seq: 13, type: MsgType.OrderCancelRequest, fields: [[Tag.ClOrdID, "cancel-a"]], sentAt: new Date(2_000) },
  ];
  session.prepare(new FixMessage(MsgType.Heartbeat), 0); // 11
  session.prepare(new FixMessage(MsgType.NewOrderSingle), 0); // 12
  session.prepare(new FixMessage(MsgType.OrderCancelRequest), 0); // 13
  session.prepare(new FixMessage(MsgType.Heartbeat), 0); // 14

  const frames = session.replay(10, 0, stored, 5_000).map(decode);
  const summary = frames.map((f) => [f.seq, f.message.type, f.message.get(Tag.NewSeqNo) ?? f.message.get(Tag.ClOrdID)]);
  assert.deepEqual(summary, [
    [10, MsgType.SequenceReset, "12"], // the Logon and the heartbeat: skipped
    [12, MsgType.NewOrderSingle, "order-a"],
    [13, MsgType.OrderCancelRequest, "cancel-a"],
    [14, MsgType.SequenceReset, "15"],
  ]);
  assert.ok(frames.every((f) => f.message.get(Tag.PossDupFlag) === "Y"));
  assert.equal(frames[1]?.message.get(Tag.OrigSendingTime), "19700101-00:00:01.000");
  assert.equal(session.sequence()?.nextOut, 15, "a replay uses no new numbers");
});

test("a number lower than expected without PossDup ends the session", () => {
  const session = new Session(config, { nextOut: 1, nextIn: 9 });
  session.connected(0);
  session.receive(incoming(MsgType.Logon, 9), 9, 0);
  const actions = session.receive(incoming(MsgType.ExecutionReport, 5), 5, 0);
  assert.equal(actions.at(-1)?.kind, "disconnect");
  assert.deepEqual(session.receive(incoming(MsgType.ExecutionReport, 5, [[Tag.PossDupFlag, "Y"]]), 5, 0), []);
});
