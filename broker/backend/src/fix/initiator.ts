// The broker's FIX connection: the socket around a Session, plus persistence.
//
// Everything runs through one serial queue: inbound messages, outbound orders and the
// heartbeat clock never interleave, so the in-memory sequence numbers and the database
// always agree. Two rules make a crash at any point recoverable:
//
//   1. A sequence number is saved BEFORE the bytes that use it are written. Restarting can
//      skip a number (the exchange asks for it, and gets a gap fill or the stored message)
//      but never reuse one, which the exchange would treat as fatal.
//   2. An application message is applied in the SAME transaction that moves `next_in_seq`
//      past it. Either both happen or neither does; if neither, the exchange resends it.
//
// Single instance only: two processes would share a SenderCompID and its numbering. A
// Postgres advisory lock, taken at start, enforces that.

import { type Socket, connect } from "node:net";

import pg from "pg";

import { type Db, transaction } from "../db.ts";
import { Decoder, type FixMessage } from "./codec.ts";
import { type Action, type SequenceState, Session, type SessionConfig, type StoredMessage } from "./session.ts";

export interface Handlers {
  /** Applies one application message, inside the transaction that records its receipt. */
  onMessage(db: Db, message: FixMessage): Promise<void>;
  /** Logged on (or back on). Runs after the logon is processed. */
  onActive(): Promise<void>;
}

export interface InitiatorConfig extends SessionConfig {
  host: string;
  port: number;
}

/** Arbitrary but fixed: "one broker FIX session" in Postgres advisory-lock space. */
const SINGLETON_LOCK = 7_340_031;

export class Initiator {
  private readonly config: InitiatorConfig;
  private readonly pool: pg.Pool;
  private readonly handlers: Handlers;
  private session: Session;
  private socket: Socket | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private backoffMs = 1000;
  private stopping = false;
  private lockClient: pg.PoolClient | undefined;
  /** What the database holds, so an unchanged sequence is not written again. */
  private saved: SequenceState | undefined;

  private constructor(config: InitiatorConfig, pool: pg.Pool, handlers: Handlers, stored?: SequenceState) {
    this.config = config;
    this.pool = pool;
    this.handlers = handlers;
    this.session = new Session(config, stored);
  }

  /** Takes the single-instance lock and loads the stored sequence numbers. */
  static async open(config: InitiatorConfig, pool: pg.Pool, handlers: Handlers): Promise<Initiator> {
    const lockClient = await pool.connect();
    const { rows: lock } = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SINGLETON_LOCK],
    );
    if (!lock[0]?.locked) {
      lockClient.release();
      throw new Error("another backend already holds the FIX session; only one may run");
    }
    const stored = await loadSequence(pool, config.sender);
    const initiator = new Initiator(config, pool, handlers, stored);
    initiator.lockClient = lockClient;
    initiator.saved = stored;
    return initiator;
  }

  start(): void {
    this.timer = setInterval(() => void this.serial(() => this.apply(this.session.tick(Date.now()))), 1000);
    this.open();
  }

  isActive(): boolean {
    return this.session.isActive();
  }

  lastHeardAt(): number | undefined {
    return this.session.lastHeardAt();
  }

  /**
   * Sends an application message. Its sequence number, a stored copy (for resends) and
   * whatever `alongside` writes all commit together, before a byte is written.
   */
  send(message: FixMessage, alongside?: (db: Db) => Promise<void>): Promise<number> {
    return this.serial(async () => {
      if (!this.session.isActive()) throw new Error("the FIX session is not logged on");
      const before = this.session.sequence();
      const now = Date.now();
      const prepared = this.session.prepare(message, now);
      try {
        await transaction(this.pool, async (db) => {
          await db.query(
            `INSERT INTO broker.fix_outbound (sender_comp_id, seq, msg_type, fields, sent_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [this.config.sender, prepared.seq, message.type, JSON.stringify(message.bodyFields()), new Date(now)],
          );
          await saveSequence(db, this.config, this.session.sequence()!);
          if (alongside) await alongside(db);
        });
        this.saved = this.session.sequence();
      } catch (error) {
        // Nothing was sent: put the number back.
        this.session.rewind(before);
        throw error;
      }
      this.socket?.write(prepared.bytes);
      return prepared.seq;
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.serial(() => this.apply(this.session.logout(Date.now())));
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.socket?.destroy();
    await this.serial(() => this.persist(this.pool)); // the Logout reply's number too
    if (this.lockClient) {
      await this.lockClient.query("SELECT pg_advisory_unlock($1)", [SINGLETON_LOCK]);
      this.lockClient.release();
    }
  }

  /** Writes the current sequence numbers, if they changed since the last write. */
  private async persist(db: Db): Promise<void> {
    const now = this.session.sequence();
    if (!now || (this.saved && now.nextIn === this.saved.nextIn && now.nextOut === this.saved.nextOut)) return;
    await saveSequence(db, this.config, now);
    this.saved = now;
  }

  /** Runs `work` after everything queued before it, and returns its result. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.catch(() => {});
    return result;
  }

  private open(): void {
    const decoder = new Decoder();
    const socket = connect({ host: this.config.host, port: this.config.port, noDelay: true });
    this.socket = socket;
    socket.on("connect", () => {
      this.backoffMs = 1000;
      void this.serial(() => this.apply(this.session.connected(Date.now())));
    });
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (let frame = decoder.next(); frame; frame = decoder.next()) {
        if (frame.kind === "garbled") {
          console.warn(`fix: ignored a garbled frame (${frame.why})`);
          continue;
        }
        const { message, seq } = frame;
        void this.serial(() => this.apply(this.session.receive(message, seq, Date.now()))).catch((error) => {
          console.error(`fix: failed to process MsgType ${message.type} seq ${seq}: ${(error as Error).message}`);
          socket.destroy(); // reconnect; the exchange resends from the last number we saved
        });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      const wasActive = this.session.isActive();
      this.session.disconnected();
      if (this.stopping) return;
      console.warn(`fix: ${wasActive ? "connection lost" : `cannot reach ${this.config.host}:${this.config.port}`}; retrying in ${this.backoffMs / 1000}s`);
      setTimeout(() => {
        // Reload numbers from the database: they are the truth after a failed transaction.
        void loadSequence(this.pool, this.config.sender).then((stored) => {
          this.session = new Session(this.config, stored);
          this.saved = stored;
          this.open();
        });
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  private async apply(actions: Action[]): Promise<void> {
    // Rule 1: save the numbers before writing the bytes that use them. Saved whenever they
    // moved, sends or not, so a restart does not ask for heartbeats it already read.
    if (!actions.some((a) => a.kind === "deliver")) await this.persist(this.pool);
    for (const action of actions) {
      switch (action.kind) {
        case "send":
          this.socket?.write(action.bytes);
          break;
        case "deliver":
          // Rule 2: the message's effects and its receipt commit together.
          await transaction(this.pool, async (db) => {
            await this.handlers.onMessage(db, action.message);
            await this.persist(db);
          });
          break;
        case "resend": {
          const stored = await loadOutbound(this.pool, this.config.sender, action.begin, action.end);
          for (const bytes of this.session.replay(action.begin, action.end, stored, Date.now())) {
            this.socket?.write(bytes);
          }
          console.log(`fix: resent ${action.begin}..${action.end || "latest"} (${stored.length} stored message(s))`);
          break;
        }
        case "gap":
          console.log(`fix: expected ${action.from}, got ${action.received}; asking the exchange to resend`);
          break;
        case "active":
          console.log(`fix: logged on to ${this.config.target} as ${this.config.sender}`);
          // After this task, so its own sends can queue behind it.
          setImmediate(() => void this.handlers.onActive().catch((e) => console.error(`fix: after logon: ${(e as Error).message}`)));
          break;
        case "disconnect":
          console.warn(`fix: disconnecting: ${action.why}`);
          this.socket?.destroy();
          break;
      }
    }
  }
}

async function loadSequence(db: Db, sender: string): Promise<SequenceState | undefined> {
  const { rows } = await db.query<{ next_out_seq: number; next_in_seq: number }>(
    "SELECT next_out_seq, next_in_seq FROM broker.fix_session WHERE sender_comp_id = $1",
    [sender],
  );
  const row = rows[0];
  return row ? { nextOut: row.next_out_seq, nextIn: row.next_in_seq } : undefined;
}

async function saveSequence(db: Db, config: SessionConfig, seq: SequenceState): Promise<void> {
  await db.query(
    `INSERT INTO broker.fix_session (sender_comp_id, target_comp_id, next_out_seq, next_in_seq)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sender_comp_id) DO UPDATE
       SET next_out_seq = EXCLUDED.next_out_seq, next_in_seq = EXCLUDED.next_in_seq, updated_at = now()`,
    [config.sender, config.target, seq.nextOut, seq.nextIn],
  );
}

async function loadOutbound(db: Db, sender: string, begin: number, end: number): Promise<StoredMessage[]> {
  const { rows } = await db.query<{ seq: number; msg_type: string; fields: [number, string][]; sent_at: Date }>(
    `SELECT seq, msg_type, fields, sent_at FROM broker.fix_outbound
     WHERE sender_comp_id = $1 AND seq >= $2 AND ($3 = 0 OR seq <= $3)
     ORDER BY seq`,
    [sender, begin, end],
  );
  return rows.map((r) => ({ seq: r.seq, type: r.msg_type, fields: r.fields, sentAt: r.sent_at }));
}
