// Users, passwords and sessions. Passwords are stored as scrypt hashes with a random salt;
// sessions are random bearer tokens held in memory, so a restart logs everyone out (fine
// for now, and it keeps the database free of anything secret but the hashes).

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { Db } from "../db.ts";
import { ulid } from "../ids.ts";
import { seedWatchlist } from "../watchlist.ts";

const derive = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
const SESSION_MS = 12 * 3_600_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await derive(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Creates a user with one brokerage account. Returns undefined if the email is taken. */
export async function signUp(
  db: Db,
  email: string,
  password: string,
  name: string,
): Promise<{ userId: string; accountId: string } | undefined> {
  const userId = ulid();
  const created = await db.query(
    `INSERT INTO broker.users (user_id, email, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT users_email_unique DO NOTHING`,
    [userId, email.toLowerCase(), await hashPassword(password)],
  );
  if (created.rowCount === 0) return undefined;
  const accountId = ulid();
  await db.query("INSERT INTO broker.accounts (account_id, name, user_id) VALUES ($1, $2, $3)", [
    accountId,
    name,
    userId,
  ]);
  await db.query("INSERT INTO broker.risk_limits (account_id) VALUES ($1)", [accountId]);
  await seedWatchlist(db, accountId);
  return { userId, accountId };
}

export interface Session {
  userId: string;
  accountId: string;
  expiresAt: number;
}

export class Sessions {
  private readonly sessions = new Map<string, Session>();

  async logIn(db: Db, email: string, password: string): Promise<string | undefined> {
    const { rows } = await db.query<{ user_id: string; password_hash: string; account_id: string }>(
      `SELECT u.user_id, u.password_hash, a.account_id
       FROM broker.users u JOIN broker.accounts a USING (user_id)
       WHERE u.email = $1 ORDER BY a.created_at LIMIT 1`,
      [email.toLowerCase()],
    );
    const user = rows[0];
    // Hash even when there is no such user, so the response time does not reveal which.
    const ok = await verifyPassword(password, user?.password_hash ?? `${"0".repeat(32)}:${"0".repeat(64)}`);
    if (!user || !ok) return undefined;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { userId: user.user_id, accountId: user.account_id, expiresAt: Date.now() + SESSION_MS });
    return token;
  }

  find(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }
}
