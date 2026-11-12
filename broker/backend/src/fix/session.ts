// The broker's FIX session with the exchange, as a pure state machine: messages and clock
// ticks in, actions out. No sockets and no database, so every rule is tested directly.
//
// Unlike a simulator, a broker cannot afford to lose an execution report: a missed fill is
// a client's money. So sequence numbers are never reset after the first logon. Whatever
// the exchange sent while we were away, we ask for again (ResendRequest), and whatever it
// missed from us, we send again from the stored copy, flagged PossDupFlag=Y. The caller
// persists `nextIn` and `nextOut` (see initiator.ts) so this survives a restart.

import { FixMessage, encode, fixTime } from "./codec.ts";
import { ADMIN_TYPES, MsgType, Tag } from "./tags.ts";

export type Action =
  | { kind: "send"; bytes: Buffer }
  /** An application message, in sequence. `seq` is the number it consumed. */
  | { kind: "deliver"; message: FixMessage; seq: number }
  | { kind: "active" }
  /** We noticed missing messages and asked for them from `from` onward. */
  | { kind: "gap"; from: number; received: number }
  /** The exchange wants messages `begin` to `end` (0 = to the latest) again. */
  | { kind: "resend"; begin: number; end: number }
  | { kind: "disconnect"; why: string };

export interface SessionConfig {
  sender: string;
  target: string;
  heartbeatSecs: number;
}

export interface SequenceState {
  nextOut: number;
  nextIn: number;
}

/** An application message we sent, as stored for a resend. */
export interface StoredMessage {
  seq: number;
  type: string;
  fields: [number, string][];
  sentAt: Date;
}

type State = "disconnected" | "logonSent" | "active" | "logoutSent";

export class Session {
  private readonly config: SessionConfig;
  private state: State = "disconnected";
  /** Undefined until the first logon: that one asks for a reset. */
  private seq: SequenceState | undefined;
  private lastSent = 0;
  private lastReceived = 0;
  /** When the exchange last sent us anything, heartbeats included. Undefined until it has. */
  private lastHeard: number | undefined;
  private testRequestSentAt: number | undefined;
  private resendRequested = false;

  constructor(config: SessionConfig, stored?: SequenceState) {
    this.config = config;
    this.seq = stored ? { ...stored } : undefined;
  }

  isActive(): boolean {
    return this.state === "active";
  }

  /** When the exchange last sent us anything (ms since the epoch), or undefined if it never has. */
  lastHeardAt(): number | undefined {
    return this.lastHeard;
  }

  /** The numbers to persist. Defined once the session has started. */
  sequence(): SequenceState | undefined {
    return this.seq ? { ...this.seq } : undefined;
  }

  connected(now: number): Action[] {
    this.state = "logonSent";
    this.resendRequested = false;
    this.testRequestSentAt = undefined;
    this.lastReceived = now;
    const logon = new FixMessage(MsgType.Logon)
      .set(Tag.EncryptMethod, 0)
      .set(Tag.HeartBtInt, this.config.heartbeatSecs);
    if (!this.seq) {
      // Never logged on before: both sides start at 1. The only time we ask for this.
      this.seq = { nextOut: 1, nextIn: 1 };
      logon.set(Tag.ResetSeqNumFlag, "Y");
    }
    return [this.out(logon, now)];
  }

  disconnected(): void {
    this.state = "disconnected";
  }

  /** Puts the numbers back after a prepared message turned out not to be sent. */
  rewind(to: SequenceState | undefined): void {
    this.seq = to ? { ...to } : undefined;
  }

  /** Numbers and encodes an application message. Only while active. */
  prepare(message: FixMessage, now: number): { seq: number; bytes: Buffer } {
    if (this.state !== "active" || !this.seq) throw new Error(`cannot send while ${this.state}`);
    const seq = this.seq.nextOut;
    const action = this.out(message, now);
    if (action.kind !== "send") throw new Error("unreachable");
    return { seq, bytes: action.bytes };
  }

  logout(now: number, text = "shutting down"): Action[] {
    if (this.state !== "active") return [];
    this.state = "logoutSent";
    return [this.out(new FixMessage(MsgType.Logout).set(Tag.Text, text), now)];
  }

  tick(now: number): Action[] {
    if (this.state !== "active") return [];
    const interval = this.config.heartbeatSecs * 1000;
    if (this.testRequestSentAt !== undefined) {
      return now - this.testRequestSentAt > interval
        ? [{ kind: "disconnect", why: "no answer to TestRequest" }]
        : [];
    }
    const actions: Action[] = [];
    if (now - this.lastReceived > interval * 1.2) {
      this.testRequestSentAt = now;
      actions.push(this.out(new FixMessage(MsgType.TestRequest).set(Tag.TestReqID, `T${now}`), now));
    } else if (now - this.lastSent >= interval) {
      actions.push(this.out(new FixMessage(MsgType.Heartbeat), now));
    }
    return actions;
  }

  receive(message: FixMessage, seq: number, now: number): Action[] {
    if (!this.seq) return [{ kind: "disconnect", why: "message before logon" }];
    this.lastReceived = now;
    this.lastHeard = now;
    this.testRequestSentAt = undefined;

    if (
      message.get(Tag.SenderCompID) !== this.config.target ||
      message.get(Tag.TargetCompID) !== this.config.sender
    ) {
      return [{ kind: "disconnect", why: "CompIDs do not match this session" }];
    }
    if (this.state === "logonSent" && message.type !== MsgType.Logon) {
      return [{ kind: "disconnect", why: `expected a Logon reply, got MsgType ${message.type}` }];
    }
    if (message.type === MsgType.Logon && message.getBool(Tag.ResetSeqNumFlag)) {
      this.seq.nextIn = seq; // the exchange acknowledged the reset
    }
    if (message.type === MsgType.SequenceReset && !message.getBool(Tag.GapFillFlag)) {
      const next = message.getInt(Tag.NewSeqNo);
      if (next !== undefined && next > this.seq.nextIn) this.seq.nextIn = next;
      return [];
    }

    if (seq < this.seq.nextIn) {
      if (message.getBool(Tag.PossDupFlag)) return [];
      const why = `MsgSeqNum too low: expected ${this.seq.nextIn}, got ${seq}`;
      return [...this.logout(now, why), { kind: "disconnect", why }];
    }

    if (seq > this.seq.nextIn) {
      // Messages are missing: ask for them once, and wait for them to arrive in order.
      const actions: Action[] = [];
      if (message.type === MsgType.Logon) {
        // The exchange sent things while we were away. Log on, then catch up.
        this.state = "active";
        actions.push({ kind: "active" });
      }
      if (!this.resendRequested) {
        this.resendRequested = true;
        actions.push({ kind: "gap", from: this.seq.nextIn, received: seq });
        const request = new FixMessage(MsgType.ResendRequest)
          .set(Tag.BeginSeqNo, this.seq.nextIn)
          .set(Tag.EndSeqNo, 0);
        actions.push(this.out(request, now));
      }
      if (message.type === MsgType.ResendRequest) actions.push(this.resendAction(message));
      if (message.type === MsgType.Logout) actions.push(...this.onLogout(now));
      return actions;
    }

    // In sequence.
    this.seq.nextIn = seq + 1;
    if (!message.getBool(Tag.PossDupFlag)) this.resendRequested = false;

    switch (message.type) {
      case MsgType.Logon:
        if (this.state !== "logonSent") return [{ kind: "disconnect", why: "unexpected Logon" }];
        this.state = "active";
        return [{ kind: "active" }];
      case MsgType.Heartbeat:
        return [];
      case MsgType.TestRequest:
        return [this.out(new FixMessage(MsgType.Heartbeat).set(Tag.TestReqID, message.get(Tag.TestReqID) ?? ""), now)];
      case MsgType.ResendRequest:
        return [this.resendAction(message)];
      case MsgType.SequenceReset: {
        const next = message.getInt(Tag.NewSeqNo);
        if (next !== undefined && next > this.seq.nextIn) this.seq.nextIn = next;
        return [];
      }
      case MsgType.Logout:
        return this.onLogout(now);
      default:
        return [{ kind: "deliver", message, seq }];
    }
  }

  /**
   * Builds the answer to a ResendRequest from what was stored. Application messages are sent
   * again with PossDupFlag=Y and their original SendingTime; everything in between (session
   * messages, which are never resent) is covered by gap fills. Numbers already used are
   * reused: nothing here consumes a new one.
   */
  replay(begin: number, end: number, stored: StoredMessage[], now: number): Buffer[] {
    if (!this.seq) return [];
    const last = end === 0 || end >= this.seq.nextOut ? this.seq.nextOut - 1 : end;
    const bySeq = new Map(stored.map((m) => [m.seq, m]));
    const frames: Buffer[] = [];
    const time = fixTime(new Date(now));
    let seq = begin;
    while (seq <= last) {
      const message = bySeq.get(seq);
      if (message && !ADMIN_TYPES.has(message.type)) {
        frames.push(
          encode(new FixMessage(message.type, message.fields), {
            sender: this.config.sender,
            target: this.config.target,
            seq,
            sendingTime: time,
            origSendingTime: fixTime(message.sentAt),
          }),
        );
        seq += 1;
        continue;
      }
      let next = seq + 1;
      while (next <= last && !bySeq.has(next)) next += 1;
      const fill = new FixMessage(MsgType.SequenceReset).set(Tag.GapFillFlag, "Y").set(Tag.NewSeqNo, next);
      frames.push(
        encode(fill, {
          sender: this.config.sender,
          target: this.config.target,
          seq,
          sendingTime: time,
          origSendingTime: time,
        }),
      );
      seq = next;
    }
    this.lastSent = now;
    return frames;
  }

  private resendAction(request: FixMessage): Action {
    return {
      kind: "resend",
      begin: request.getInt(Tag.BeginSeqNo) ?? 1,
      end: request.getInt(Tag.EndSeqNo) ?? 0,
    };
  }

  private onLogout(now: number): Action[] {
    const actions: Action[] = [];
    if (this.state === "active") actions.push(this.out(new FixMessage(MsgType.Logout), now));
    actions.push({ kind: "disconnect", why: "logged out" });
    return actions;
  }

  private out(message: FixMessage, now: number): Action {
    if (!this.seq) throw new Error("no sequence state");
    const bytes = encode(message, {
      sender: this.config.sender,
      target: this.config.target,
      seq: this.seq.nextOut,
      sendingTime: fixTime(new Date(now)),
    });
    this.seq.nextOut += 1;
    this.lastSent = now;
    return { kind: "send", bytes };
  }
}
