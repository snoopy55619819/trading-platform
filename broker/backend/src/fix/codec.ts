// FIX 4.4 framing: tag=value fields separated by SOH, BeginString and BodyLength in front,
// CheckSum behind. The broker's own implementation of the venue's published spec; it
// shares no code with the exchange (Rust) or with any other firm's client.

import { Tag } from "./tags.ts";

const SOH = 0x01;
const BEGIN = Buffer.from("8=FIX.4.4\x01", "latin1");

export class FixMessage {
  readonly type: string;
  readonly fields = new Map<number, string>();

  constructor(type: string, fields?: Iterable<[number, string]>) {
    this.type = type;
    if (fields) for (const [tag, value] of fields) this.fields.set(tag, value);
  }

  set(tag: number, value: string | number): this {
    this.fields.set(tag, String(value));
    return this;
  }

  get(tag: number): string | undefined {
    return this.fields.get(tag);
  }

  getInt(tag: number): number | undefined {
    const text = this.fields.get(tag);
    return text !== undefined && /^-?\d+$/.test(text) ? Number(text) : undefined;
  }

  getBool(tag: number): boolean {
    return this.fields.get(tag) === "Y";
  }

  /** The body fields only, for storing an outbound message to resend later. */
  bodyFields(): [number, string][] {
    return [...this.fields];
  }
}

export interface Header {
  sender: string;
  target: string;
  seq: number;
  sendingTime: string;
  /** Set on a resend: the message may already have been received. */
  origSendingTime?: string;
}

export function encode(message: FixMessage, header: Header): Buffer {
  const parts = [
    `35=${message.type}`,
    `49=${header.sender}`,
    `56=${header.target}`,
    `34=${header.seq}`,
    `52=${header.sendingTime}`,
  ];
  if (header.origSendingTime) parts.push("43=Y", `122=${header.origSendingTime}`);
  for (const [tag, value] of message.fields) {
    if (value.includes("\x01")) throw new Error(`tag ${tag} contains SOH`);
    parts.push(`${tag}=${value}`);
  }
  const body = Buffer.from(`${parts.join("\x01")}\x01`, "latin1");
  const head = Buffer.from(`8=FIX.4.4\x019=${body.length}\x01`, "latin1");
  const sum = (byteSum(head) + byteSum(body)) % 256;
  return Buffer.concat([head, body, Buffer.from(`10=${String(sum).padStart(3, "0")}\x01`, "latin1")]);
}

function byteSum(bytes: Buffer): number {
  let sum = 0;
  for (const byte of bytes) sum += byte;
  return sum;
}

export type Frame =
  | { kind: "message"; message: FixMessage; seq: number }
  | { kind: "garbled"; why: string };

/** Splits a byte stream into frames. */
export class Decoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  next(): Frame | undefined {
    if (this.buffer.length === 0) return undefined;
    const start = this.buffer.indexOf(BEGIN);
    if (start === -1) {
      this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - BEGIN.length));
      return undefined;
    }
    if (start > 0) {
      this.buffer = this.buffer.subarray(start);
      return { kind: "garbled", why: `skipped ${start} bytes before BeginString` };
    }
    const lengthEnd = this.buffer.indexOf(SOH, BEGIN.length);
    if (lengthEnd === -1) return undefined;
    const lengthField = this.buffer.toString("latin1", BEGIN.length, lengthEnd);
    if (!/^9=\d+$/.test(lengthField)) {
      this.buffer = this.buffer.subarray(1);
      return { kind: "garbled", why: `bad BodyLength ${JSON.stringify(lengthField)}` };
    }
    const bodyStart = lengthEnd + 1;
    const bodyEnd = bodyStart + Number(lengthField.slice(2));
    const frameEnd = bodyEnd + 7;
    if (this.buffer.length < frameEnd) return undefined;

    const frame = this.buffer.subarray(0, frameEnd);
    this.buffer = this.buffer.subarray(frameEnd);
    const expected = String(byteSum(frame.subarray(0, bodyEnd)) % 256).padStart(3, "0");
    const trailer = frame.toString("latin1", bodyEnd, frameEnd);
    if (trailer !== `10=${expected}\x01`) return { kind: "garbled", why: `bad CheckSum ${trailer}` };

    const fields = frame.toString("latin1", bodyStart, bodyEnd).split("\x01");
    fields.pop();
    if (!fields[0]?.startsWith("35=")) return { kind: "garbled", why: "MsgType is not first" };
    const message = new FixMessage(fields[0].slice(3));
    for (const field of fields.slice(1)) {
      const equals = field.indexOf("=");
      if (equals <= 0) return { kind: "garbled", why: `malformed field ${field}` };
      message.set(Number(field.slice(0, equals)), field.slice(equals + 1));
    }
    const seq = message.getInt(Tag.MsgSeqNum);
    if (seq === undefined) return { kind: "garbled", why: "no MsgSeqNum" };
    return { kind: "message", message, seq };
  }
}

/** FIX UTCTimestamp with milliseconds. */
export function fixTime(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 23)}`;
}

/** Integer cents as a FIX price, with no float in between. */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** A FIX price as integer cents, exactly. Refuses anything finer than a cent. */
export function parseCents(text: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2})0*)?$/.exec(text);
  if (!match) throw new Error(`not a price in cents: ${JSON.stringify(text)}`);
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -cents : cents;
}
