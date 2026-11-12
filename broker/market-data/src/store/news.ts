// Headlines from the newswire: checked, stored once, and read back newest first.

import type { Db } from "../db.ts";

/** A headline, as the newswire publishes it (vendor/newswire/README.md) and as we serve it. */
export interface Headline {
  id: string;
  ts: string;
  symbol: string;
  headline: string;
  category: string;
  tone: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  severity: "MINOR" | "MAJOR";
}

const TONES = new Set(["POSITIVE", "NEGATIVE", "NEUTRAL"]);
const SEVERITIES = new Set(["MINOR", "MAJOR"]);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A headline we can store, or why not. Follows headline.schema.json, except that an unknown
 * category is fine (the spec says to accept them), and the symbol must be one we list.
 */
export function checkHeadline(value: unknown, symbols: readonly string[]): Headline | string {
  if (typeof value !== "object" || value === null) return "not an object";
  const h = value as Record<string, unknown>;
  if (typeof h.id !== "string" || !ULID.test(h.id)) return "id: not a ULID";
  if (typeof h.ts !== "string" || Number.isNaN(Date.parse(h.ts))) return "ts: not a time";
  if (typeof h.symbol !== "string" || !symbols.includes(h.symbol)) return `symbol: ${String(h.symbol)} is not listed`;
  if (typeof h.headline !== "string" || h.headline.length === 0 || h.headline.length > 160) return "headline: 1 to 160 characters";
  if (typeof h.category !== "string" || h.category.length === 0) return "category: missing";
  if (typeof h.tone !== "string" || !TONES.has(h.tone)) return `tone: ${String(h.tone)}`;
  if (typeof h.severity !== "string" || !SEVERITIES.has(h.severity)) return `severity: ${String(h.severity)}`;
  return {
    id: h.id,
    ts: new Date(h.ts).toISOString(),
    symbol: h.symbol,
    headline: h.headline,
    category: h.category,
    tone: h.tone as Headline["tone"],
    severity: h.severity as Headline["severity"],
  };
}

/** Stores a headline; true if it was new, false if we already had it. */
export async function insertHeadline(db: Db, h: Headline): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO market_data.news (id, ts, symbol, headline, category, tone, severity)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [h.id, h.ts, h.symbol, h.headline, h.category, h.tone, h.severity],
  );
  return result.rowCount === 1;
}

/** When the newest stored headline was published: where a catch-up starts. */
export async function newestHeadlineTs(db: Db): Promise<string | undefined> {
  const { rows } = await db.query<{ ts: Date | null }>("SELECT max(ts) AS ts FROM market_data.news");
  return rows[0]?.ts?.toISOString();
}

/** The latest `limit` headlines, newest first: for one symbol, or for all of them. */
export async function recentNews(db: Db, symbol: string | undefined, limit: number): Promise<Headline[]> {
  const { rows } = await db.query<{
    id: string;
    ts: Date;
    symbol: string;
    headline: string;
    category: string;
    tone: Headline["tone"];
    severity: Headline["severity"];
  }>(
    `SELECT id, ts, symbol, headline, category, tone, severity FROM market_data.news
      WHERE $1::text IS NULL OR symbol = $1
      ORDER BY ts DESC, id DESC LIMIT $2`,
    [symbol ?? null, limit],
  );
  return rows.map((r) => ({ ...r, ts: r.ts.toISOString() }));
}
