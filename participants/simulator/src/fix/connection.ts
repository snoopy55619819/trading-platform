// The socket around a Session: connects, feeds bytes in, writes actions out, runs the
// heartbeat clock, and reconnects with backoff when the line drops. No FIX rules here.

import { Socket, connect } from "node:net";

import { Decoder, type FixMessage } from "./codec.ts";
import { type Action, Session, type SessionConfig } from "./session.ts";

export interface ConnectionEvents {
  /** Logged on. Anything sent before this was refused. */
  onActive(): void;
  /** An application message, or a session Reject. */
  onMessage(message: FixMessage): void;
  /** The session ended. A reconnect is already scheduled unless `stop` was called. */
  onDown(why: string): void;
}

export class FixConnection {
  private readonly session: Session;
  private readonly host: string;
  private readonly port: number;
  private readonly events: ConnectionEvents;
  private socket: Socket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private backoffMs = 1000;
  private stopping = false;

  constructor(host: string, port: number, config: SessionConfig, events: ConnectionEvents) {
    this.host = host;
    this.port = port;
    this.session = new Session(config);
    this.events = events;
  }

  start(): void {
    this.timer = setInterval(() => this.apply(this.session.tick(Date.now())), 1000);
    this.open();
  }

  isActive(): boolean {
    return this.session.isActive();
  }

  send(message: FixMessage): void {
    this.apply(this.session.send(message, Date.now()));
  }

  /** Logs out and closes; does not reconnect. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.apply(this.session.logout(Date.now()));
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.socket?.destroy();
  }

  private open(): void {
    const decoder = new Decoder();
    const socket = connect({ host: this.host, port: this.port, noDelay: true });
    this.socket = socket;
    socket.on("connect", () => {
      this.backoffMs = 1000;
      this.apply(this.session.connected(Date.now()));
    });
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (let frame = decoder.next(); frame; frame = decoder.next()) {
        if (frame.kind === "garbled") {
          console.warn(`fix: ignored a garbled frame (${frame.why})`);
          continue;
        }
        this.apply(this.session.receive(frame.message, frame.seq, Date.now()));
      }
    });
    socket.on("error", () => {}); // "close" follows and handles it
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      const wasActive = this.session.isActive();
      this.session.disconnected();
      if (this.stopping) return;
      this.events.onDown(wasActive ? "connection lost" : `cannot reach ${this.host}:${this.port}`);
      setTimeout(() => this.open(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  private apply(actions: Action[]): void {
    for (const action of actions) {
      switch (action.kind) {
        case "send":
          this.socket?.write(action.bytes);
          break;
        case "deliver":
          this.events.onMessage(action.message);
          break;
        case "active":
          this.events.onActive();
          break;
        case "disconnect":
          console.warn(`fix: disconnecting: ${action.why}`);
          this.socket?.destroy();
          break;
      }
    }
  }
}
