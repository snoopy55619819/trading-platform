// FIX 4.4 on the wire: tag=value fields separated by SOH (byte 0x01), framed by
// BeginString and BodyLength at the front and a CheckSum at the back.
//
// Written against the venue's published dictionary, not the exchange's code. The two
// implementations agreeing over a socket is the test that both read the spec the same way.

import { Tag } from "./tags.ts";

const SOH = 0x01;
const BEGIN = Buffer.from("8=FIX.4.4\x01", "latin1");

export class FixMessage {
  readonly type: string;
  readonly fields = new Map<number, string>();

  constructor(type: string) {
    this.type = type;
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
    return text === undefined || !/^-?\d+$/.test(text) ? undefined : Number(text);
  }

  getBool(tag: number): boolean {
    return this.fields.get(tag) === "Y";
  }
}

/** Header fields the session adds to every outgoing message. */
export interface Header {
  sender: string;
  target: string;
  seq: number;
  sendingTime: string;
  possDup?: { origSendingTime: string };
}

export function encode(message: FixMessage, header: Header): Buffer {
  const parts: string[] = [
    `35=${message.type}`,
    `49=${header.sender}`,
    `56=${header.target}`,
    `34=${header.seq}`,
    `52=${header.sendingTime}`,
  ];
  if (header.possDup) {
    parts.push(`43=Y`, `122=${header.possDup.origSendingTime}`);
  }
  for (const [tag, value] of message.fields) {
    parts.push(`${tag}=${value}`);
  }
  const body = Buffer.from(parts.join("\x01") + "\x01", "latin1");
  const head = Buffer.from(`8=FIX.4.4\x019=${body.length}\x01`, "latin1");
  const sum = (checksum(head) + checksum(body)) % 256;
  const trailer = Buffer.from(`10=${String(sum).padStart(3, "0")}\x01`, "latin1");
  return Buffer.concat([head, body, trailer]);
}

function checksum(bytes: Buffer): number {
  let sum = 0;
  for (const byte of bytes) sum += byte;
  return sum % 256;
}

export type Decoded =
  | { kind: "message"; message: FixMessage; seq: number }
  | { kind: "garbled"; why: string };

/** Turns a byte stream into messages. Feed it whatever the socket delivers. */
export class Decoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** The next complete frame, or undefined until more bytes arrive. */
  next(): Decoded | undefined {
    if (this.buffer.length === 0) return undefined;
    const start = this.buffer.indexOf(BEGIN);
    if (start === -1) {
      // Keep a tail in case BeginString is split across reads.
      this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - BEGIN.length));
      return undefined;
    }
    if (start > 0) {
      this.buffer = this.buffer.subarray(start);
      return { kind: "garbled", why: `skipped ${start} bytes before BeginString` };
    }

    const lengthStart = BEGIN.length;
    const lengthEnd = this.buffer.indexOf(SOH, lengthStart);
    if (lengthEnd === -1) return undefined;
    const lengthField = this.buffer.toString("latin1", lengthStart, lengthEnd);
    if (!/^9=\d+$/.test(lengthField)) {
      this.buffer = this.buffer.subarray(1);
      return { kind: "garbled", why: `bad BodyLength field ${JSON.stringify(lengthField)}` };
    }
    const bodyStart = lengthEnd + 1;
    const bodyEnd = bodyStart + Number(lengthField.slice(2));
    const frameEnd = bodyEnd + 7; // "10=NNN" + SOH
    if (this.buffer.length < frameEnd) return undefined;

    const frame = this.buffer.subarray(0, frameEnd);
    this.buffer = this.buffer.subarray(frameEnd);
    const trailer = frame.toString("latin1", bodyEnd, frameEnd);
    const expected = String(checksum(frame.subarray(0, bodyEnd))).padStart(3, "0");
    if (trailer !== `10=${expected}\x01`) {
      return { kind: "garbled", why: `checksum: expected ${expected}, got ${trailer}` };
    }

    const fields = frame.toString("latin1", bodyStart, bodyEnd).split("\x01");
    fields.pop(); // the empty string after the final SOH
    const first = fields[0];
    if (!first?.startsWith("35=")) {
      return { kind: "garbled", why: "MsgType is not the first body field" };
    }
    const message = new FixMessage(first.slice(3));
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

/** FIX UTCTimestamp with milliseconds: 20261111-14:32:11.123 */
export function fixTime(date: Date): string {
  const iso = date.toISOString(); // 2026-11-11T14:32:11.123Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 23)}`;
}

/** Integer cents as a FIX price: 4210 -> "42.10". Never goes through a float. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** A FIX price as integer cents: "42.1" -> 4210, "-0.51" -> -51. Exact, no float. */
export function parseCents(text: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(text);
  if (!match) throw new Error(`not a price: ${JSON.stringify(text)}`);
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}
