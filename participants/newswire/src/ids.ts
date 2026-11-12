// ULIDs for headline ids (docs/DECISIONS.md section 3): 48 bits of millisecond time then 80
// random bits, in Crockford base 32. They sort by creation time, so they make good index
// keys and readable logs. Small enough to write rather than import.
//
// Not seeded on purpose: a restart with the same NEWS_SEED repeats the same stories, and
// clients that drop ids they have seen must still take them as new.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  let random = "";
  for (const byte of randomBytes(16)) random += ALPHABET[byte % 32];
  return time + random;
}
