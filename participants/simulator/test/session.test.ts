import assert from "node:assert/strict";
import { test } from "node:test";

import { Decoder, FixMessage, encode } from "../src/fix/codec.ts";
import { type Action, Session } from "../src/fix/session.ts";
import { MsgType, Tag } from "../src/fix/tags.ts";

const config = { sender: "SIM", target: "ALPHA", heartbeatSecs: 10 };

/** Decodes what the session sent, so tests can read it as messages. */
function sent(actions: Action[]): { type: string; seq: number; message: FixMessage }[] {
  return actions.flatMap((action) => {
    if (action.kind !== "send") return [];
    const decoder = new Decoder();
    decoder.push(action.bytes);
    const frame = decoder.next();
    return frame?.kind === "message"
      ? [{ type: frame.message.type, seq: frame.seq, message: frame.message }]
      : [];
  });
}

/** A message from the exchange, as the session receives it. */
function incoming(type: string, seq: number, fields: [number, string][] = []) {
  const message = new FixMessage(type);
  for (const [tag, value] of fields) message.set(tag, value);
  const decoder = new Decoder();
  decoder.push(encode(message, { sender: "ALPHA", target: "SIM", seq, sendingTime: "x" }));
  const frame = decoder.next();
  if (frame?.kind !== "message") throw new Error("bad test message");
  return frame.message;
}

function loggedOn(): Session {
  const session = new Session(config);
  session.connected(0);
  const actions = session.receive(incoming(MsgType.Logon, 1), 1, 0);
  assert.deepEqual(actions, [{ kind: "active" }]);
  return session;
}

test("logon asks for a sequence reset and becomes active on the reply", () => {
  const session = new Session(config);
  const [logon] = sent(session.connected(0));
  assert.equal(logon?.type, MsgType.Logon);
  assert.equal(logon?.seq, 1);
  assert.equal(logon?.message.get(Tag.ResetSeqNumFlag), "Y");
  assert.equal(logon?.message.get(Tag.HeartBtInt), "10");
  assert.equal(session.isActive(), false);
  session.receive(incoming(MsgType.Logon, 1), 1, 0);
  assert.equal(session.isActive(), true);
});

test("application messages are numbered after the logon and delivered in order", () => {
  const session = loggedOn();
  const [order] = sent(session.send(new FixMessage(MsgType.NewOrderSingle), 0));
  assert.equal(order?.seq, 2);
  const report = session.receive(incoming(MsgType.ExecutionReport, 2), 2, 0);
  assert.equal(report[0]?.kind, "deliver");
});

test("a gap is asked for once, and the resent copies are delivered", () => {
  const session = loggedOn();
  const gap = session.receive(incoming(MsgType.ExecutionReport, 4), 4, 0);
  const [request] = sent(gap);
  assert.equal(request?.type, MsgType.ResendRequest);
  assert.equal(request?.message.get(Tag.BeginSeqNo), "2");
  assert.equal(gap.length, 1, "the out-of-order message is not delivered yet");
  assert.equal(sent(session.receive(incoming(MsgType.ExecutionReport, 5), 5, 0)).length, 0);

  const dup: [number, string][] = [[Tag.PossDupFlag, "Y"]];
  for (const seq of [2, 3, 4, 5]) {
    const actions = session.receive(incoming(MsgType.ExecutionReport, seq, dup), seq, 0);
    assert.equal(actions[0]?.kind, "deliver", `seq ${seq}`);
  }
  // A duplicate of something already processed is dropped quietly.
  assert.deepEqual(session.receive(incoming(MsgType.ExecutionReport, 3, dup), 3, 0), []);
});

test("a ResendRequest is answered with one gap fill, not with old orders", () => {
  const session = loggedOn();
  session.send(new FixMessage(MsgType.NewOrderSingle), 0); // seq 2
  session.send(new FixMessage(MsgType.NewOrderSingle), 0); // seq 3
  const request = incoming(MsgType.ResendRequest, 2, [
    [Tag.BeginSeqNo, "2"],
    [Tag.EndSeqNo, "0"],
  ]);
  const [fill, ...rest] = sent(session.receive(request, 2, 0));
  assert.equal(rest.length, 0);
  assert.equal(fill?.type, MsgType.SequenceReset);
  assert.equal(fill?.seq, 2);
  assert.equal(fill?.message.get(Tag.GapFillFlag), "Y");
  assert.equal(fill?.message.get(Tag.NewSeqNo), "4");
  assert.equal(fill?.message.get(Tag.PossDupFlag), "Y");
  const [next] = sent(session.send(new FixMessage(MsgType.NewOrderSingle), 0));
  assert.equal(next?.seq, 4, "the gap fill did not use up a number");
});

test("a sequence number lower than expected without PossDup ends the session", () => {
  const session = loggedOn();
  session.receive(incoming(MsgType.Heartbeat, 2), 2, 0);
  const actions = session.receive(incoming(MsgType.Heartbeat, 2), 2, 0);
  assert.equal(sent(actions)[0]?.type, MsgType.Logout);
  assert.equal(actions.at(-1)?.kind, "disconnect");
});

test("a TestRequest is answered with its id, and silence triggers our own", () => {
  const session = loggedOn();
  const request = incoming(MsgType.TestRequest, 2, [[Tag.TestReqID, "ping"]]);
  const [reply] = sent(session.receive(request, 2, 0));
  assert.equal(reply?.type, MsgType.Heartbeat);
  assert.equal(reply?.message.get(Tag.TestReqID), "ping");

  // 1.2 heartbeat intervals with nothing heard. The TestRequest also counts as our own
  // traffic, so no separate Heartbeat is due.
  const quiet = sent(session.tick(12_500));
  assert.deepEqual(quiet.map((m) => m.type), [MsgType.TestRequest]);
  assert.equal(session.tick(23_000)[0]?.kind, "disconnect");
});

test("messages from the wrong CompIDs are refused", () => {
  const session = new Session(config);
  session.connected(0);
  const stranger = new FixMessage(MsgType.Logon).set(Tag.SenderCompID, "EVIL").set(Tag.TargetCompID, "SIM");
  assert.equal(session.receive(stranger, 1, 0)[0]?.kind, "disconnect");
});
