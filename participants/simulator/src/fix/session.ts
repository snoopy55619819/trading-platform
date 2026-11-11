// The FIX session layer for an initiator, as a pure state machine: messages and clock
// ticks in, actions out. No sockets and no timers, so every rule is tested directly.
//
// Recovery policy: **every logon resets sequence numbers** (ResetSeqNumFlag=Y). A
// simulated trading firm would rather start clean than reconcile, so it never asks the
// exchange to resend what it missed while away; the caller cancels whatever it may still
// have resting instead. A real broker could not do this, because a missed fill is money
// (the broker's own initiator, at M6, must recover by resend). Within a connection the
// full rules still apply: gaps are detected and resent, and resend requests from the
// exchange are answered.

import { FixMessage, encode, fixTime } from "./codec.ts";
import { MsgType, Tag } from "./tags.ts";

export type Action =
  | { kind: "send"; bytes: Buffer }
  | { kind: "deliver"; message: FixMessage }
  | { kind: "active" }
  | { kind: "disconnect"; why: string };

type State = "disconnected" | "logonSent" | "active" | "logoutSent";

export interface SessionConfig {
  sender: string;
  target: string;
  heartbeatSecs: number;
}

export class Session {
  private readonly config: SessionConfig;
  private state: State = "disconnected";
  private nextOut = 1;
  private nextIn = 1;
  private lastSent = 0;
  private lastReceived = 0;
  private testRequestSentAt: number | undefined;
  /** Set while a ResendRequest is outstanding, so one gap asks once. */
  private resendRequested = false;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  isActive(): boolean {
    return this.state === "active";
  }

  /** The socket is up: log on, asking for both sides' numbering to start again at 1. */
  connected(now: number): Action[] {
    this.state = "logonSent";
    this.nextOut = 1;
    this.nextIn = 1;
    this.resendRequested = false;
    this.testRequestSentAt = undefined;
    this.lastReceived = now;
    const logon = new FixMessage(MsgType.Logon)
      .set(Tag.EncryptMethod, 0)
      .set(Tag.HeartBtInt, this.config.heartbeatSecs)
      .set(Tag.ResetSeqNumFlag, "Y");
    return [this.out(logon, now)];
  }

  disconnected(): void {
    this.state = "disconnected";
  }

  /** Sends an application message. Only valid while active. */
  send(message: FixMessage, now: number): Action[] {
    if (this.state !== "active") throw new Error(`cannot send ${message.type} while ${this.state}`);
    return [this.out(message, now)];
  }

  logout(now: number, text = "simulator stopping"): Action[] {
    if (this.state !== "active") return [];
    this.state = "logoutSent";
    return [this.out(new FixMessage(MsgType.Logout).set(Tag.Text, text), now)];
  }

  /** Call about once a second: sends heartbeats and notices a silent counterparty. */
  tick(now: number): Action[] {
    if (this.state !== "active") return [];
    const interval = this.config.heartbeatSecs * 1000;
    const actions: Action[] = [];
    if (this.testRequestSentAt !== undefined) {
      if (now - this.testRequestSentAt > interval) {
        return [{ kind: "disconnect", why: "no answer to TestRequest" }];
      }
    } else if (now - this.lastReceived > interval * 1.2) {
      this.testRequestSentAt = now;
      const request = new FixMessage(MsgType.TestRequest).set(Tag.TestReqID, `T${now}`);
      actions.push(this.out(request, now));
    }
    if (now - this.lastSent >= interval) {
      actions.push(this.out(new FixMessage(MsgType.Heartbeat), now));
    }
    return actions;
  }

  receive(message: FixMessage, seq: number, now: number): Action[] {
    this.lastReceived = now;
    this.testRequestSentAt = undefined;

    if (
      message.get(Tag.SenderCompID) !== this.config.target ||
      message.get(Tag.TargetCompID) !== this.config.sender
    ) {
      return [{ kind: "disconnect", why: "CompIDs do not match this session" }];
    }
    if (this.state === "logonSent" && message.type !== MsgType.Logon) {
      return [{ kind: "disconnect", why: `expected a Logon reply, got ${message.type}` }];
    }
    if (message.type === MsgType.SequenceReset && !message.getBool(Tag.GapFillFlag)) {
      // An administrative reset: numbering simply continues from NewSeqNo.
      const next = message.getInt(Tag.NewSeqNo);
      if (next !== undefined && next > this.nextIn) this.nextIn = next;
      return [];
    }

    if (seq < this.nextIn) {
      if (message.getBool(Tag.PossDupFlag)) return []; // a duplicate we already have
      const why = `MsgSeqNum too low: expected ${this.nextIn}, got ${seq}`;
      return [...this.logout(now, why), { kind: "disconnect", why }];
    }

    if (seq > this.nextIn) {
      // Something was lost. Ask for it once; the copy will arrive in order. A Logout or a
      // ResendRequest still needs answering now; anything else waits for its resend.
      const actions: Action[] = [];
      if (!this.resendRequested) {
        this.resendRequested = true;
        const request = new FixMessage(MsgType.ResendRequest)
          .set(Tag.BeginSeqNo, this.nextIn)
          .set(Tag.EndSeqNo, 0);
        actions.push(this.out(request, now));
      }
      if (message.type === MsgType.Logout) actions.push(...this.onLogout(now));
      if (message.type === MsgType.ResendRequest) actions.push(...this.gapFill(message, now));
      return actions;
    }

    this.nextIn = seq + 1;
    if (this.resendRequested && !message.getBool(Tag.PossDupFlag)) this.resendRequested = false;

    switch (message.type) {
      case MsgType.Logon:
        if (this.state !== "logonSent") {
          return [{ kind: "disconnect", why: "unexpected Logon on an active session" }];
        }
        this.state = "active";
        return [{ kind: "active" }];
      case MsgType.Heartbeat:
        return [];
      case MsgType.TestRequest: {
        const heartbeat = new FixMessage(MsgType.Heartbeat).set(
          Tag.TestReqID,
          message.get(Tag.TestReqID) ?? "",
        );
        return [this.out(heartbeat, now)];
      }
      case MsgType.ResendRequest:
        return this.gapFill(message, now);
      case MsgType.SequenceReset: {
        // A gap fill: the messages it covers were administrative and are skipped.
        const next = message.getInt(Tag.NewSeqNo);
        if (next !== undefined && next > this.nextIn) this.nextIn = next;
        return [];
      }
      case MsgType.Logout:
        return this.onLogout(now);
      default:
        // Session Rejects are delivered too, so the caller can log them.
        return [{ kind: "deliver", message }];
    }
  }

  /**
   * Answers a ResendRequest with one gap fill over the whole range rather than resending
   * old orders. Resending a stale order minutes later could trade at a price nobody wants
   * any more; FIX allows skipping it, and the order's owner simply never hears back.
   */
  private gapFill(request: FixMessage, now: number): Action[] {
    const begin = request.getInt(Tag.BeginSeqNo) ?? this.nextOut;
    if (begin >= this.nextOut) return [];
    const fill = new FixMessage(MsgType.SequenceReset)
      .set(Tag.GapFillFlag, "Y")
      .set(Tag.NewSeqNo, this.nextOut);
    const time = fixTime(new Date(now));
    const bytes = encode(fill, {
      sender: this.config.sender,
      target: this.config.target,
      seq: begin,
      sendingTime: time,
      possDup: { origSendingTime: time },
    });
    this.lastSent = now;
    return [{ kind: "send", bytes }];
  }

  private onLogout(now: number): Action[] {
    const actions: Action[] = [];
    if (this.state === "active") {
      actions.push(this.out(new FixMessage(MsgType.Logout), now));
    }
    actions.push({ kind: "disconnect", why: "logged out" });
    return actions;
  }

  private out(message: FixMessage, now: number): Action {
    const bytes = encode(message, {
      sender: this.config.sender,
      target: this.config.target,
      seq: this.nextOut,
      sendingTime: fixTime(new Date(now)),
    });
    this.nextOut += 1;
    this.lastSent = now;
    return { kind: "send", bytes };
  }
}
