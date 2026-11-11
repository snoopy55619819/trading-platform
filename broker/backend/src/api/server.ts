// The HTTP API: the only thing the outside world talks to. Deliberately thin. It
// authenticates, checks that a request is well formed, calls the oms or ledger module, and
// shapes the answer as JSON. No business rule lives here.
//
//   POST   /users          {email, password, name}         sign up: a user and an account
//   POST   /sessions       {email, password}                log in: {token}
//   GET    /symbols                                         what can be traded
//   ---- with Authorization: Bearer <token> ----
//   POST   /deposits       {amountCents, reference?}        add cash (stands in for a bank transfer)
//   GET    /positions                                       cash, buying power, holdings
//   POST   /orders         {clientOrderId, symbol, side, orderType, timeInForce?, priceCents?, qty}
//   GET    /orders                                          the blotter, newest first
//   GET    /orders/:id                                      one order and its history
//   DELETE /orders/:id                                      cancel
//
// Money is integer cents, quantities whole shares, in both directions. No floats.

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

import type pg from "pg";

import { transaction } from "../db.ts";
import { RejectReason } from "../domain/index.ts";
import { ulid } from "../ids.ts";
import { cashBalance, creditCash, holdings } from "../ledger/index.ts";
import type { OrderRow } from "../oms/orders.ts";
import type { OrderRequest } from "../oms/risk.ts";
import type { Oms } from "../oms/service.ts";
import { Sessions, signUp } from "./auth.ts";

const REQUESTS_PER_SEC = 20;
const MAX_BODY_BYTES = 16_384;

class HttpError extends Error {
  readonly status: number;
  readonly body: object;
  constructor(status: number, body: object) {
    super(JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}

const malformed = (text: string) => new HttpError(400, { reason: RejectReason.MALFORMED_REQUEST, text });

function orderView(order: OrderRow) {
  return {
    orderId: order.order_id,
    clientOrderId: order.client_order_id,
    venue: order.venue,
    symbol: order.symbol,
    side: order.side,
    orderType: order.order_type,
    timeInForce: order.time_in_force,
    priceCents: order.price_cents,
    qty: order.qty,
    status: order.status,
    filledQty: order.filled_qty,
    // Derived from the exact total, rounded down; never stored.
    avgFillPriceCents: order.filled_qty > 0 ? Math.floor(order.filled_notional_cents / order.filled_qty) : null,
    filledNotionalCents: order.filled_notional_cents,
    feeCents: order.fee_cents,
    rejectReason: order.reject_reason,
    rejectText: order.reject_text,
    exchangeOrderId: order.exchange_order_id,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

/** Checks a body's shape strictly: an order with a wrong-typed field is refused, not guessed at. */
function parseOrder(body: Record<string, unknown>): { clientOrderId: string; request: OrderRequest } {
  const { clientOrderId, symbol, side, orderType, timeInForce = "DAY", priceCents, qty } = body;
  if (typeof clientOrderId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(clientOrderId)) {
    throw malformed("clientOrderId: 1 to 64 letters, digits, - or _");
  }
  if (typeof symbol !== "string" || !/^[A-Z]{1,8}$/.test(symbol)) throw malformed("symbol: an upper-case ticker");
  if (side !== "BUY" && side !== "SELL") throw malformed("side: BUY or SELL");
  if (orderType !== "LIMIT" && orderType !== "MARKET") throw malformed("orderType: LIMIT or MARKET");
  if (!["DAY", "GTC", "IOC", "FOK"].includes(timeInForce as string)) throw malformed("timeInForce: DAY, GTC, IOC or FOK");
  if (!Number.isSafeInteger(qty) || (qty as number) <= 0) throw malformed("qty: a positive whole number of shares");
  if (orderType === "LIMIT" && (!Number.isSafeInteger(priceCents) || (priceCents as number) <= 0)) {
    throw malformed("priceCents: a positive whole number of cents, required for LIMIT");
  }
  if (orderType === "MARKET" && priceCents !== undefined) throw malformed("priceCents: not allowed for MARKET");
  return {
    clientOrderId,
    request: {
      symbol,
      side,
      orderType,
      timeInForce: timeInForce as OrderRequest["timeInForce"],
      priceCents: priceCents as number | undefined,
      qty: qty as number,
    },
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw malformed("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw malformed("body must be a JSON object");
  }
}

/** Per-client token buckets: REQUESTS_PER_SEC, with a second's worth of burst. */
class RequestLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: REQUESTS_PER_SEC, at: now };
    bucket.tokens = Math.min(REQUESTS_PER_SEC, bucket.tokens + ((now - bucket.at) / 1000) * REQUESTS_PER_SEC);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }
}

export function createApi(pool: pg.Pool, oms: Oms) {
  const sessions = new Sessions();
  const limiter = new RequestLimiter();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<{ status: number; body: object }> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname.replace(/\/[0-9A-HJKMNP-TV-Z]{26}$/, "/:id")}`;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!limiter.allow(token ?? req.socket.remoteAddress ?? "unknown")) {
      res.setHeader("retry-after", "1");
      return { status: 429, body: { reason: RejectReason.RATE_LIMIT_EXCEEDED, text: `at most ${REQUESTS_PER_SEC} requests a second` } };
    }

    // ---- no session needed ----
    if (route === "POST /users") {
      const { email, password, name } = await readJson(req);
      if (typeof email !== "string" || !email.includes("@")) throw malformed("email");
      if (typeof password !== "string" || password.length < 8) throw malformed("password: at least 8 characters");
      const created = await transaction(pool, (db) => signUp(db, email, password, typeof name === "string" ? name : email));
      if (!created) return { status: 409, body: { text: "that email already has an account" } };
      return { status: 201, body: created };
    }
    if (route === "POST /sessions") {
      const { email, password } = await readJson(req);
      if (typeof email !== "string" || typeof password !== "string") throw malformed("email and password");
      const issued = await sessions.logIn(pool, email, password);
      if (!issued) return { status: 401, body: { text: "wrong email or password" } };
      return { status: 201, body: { token: issued } };
    }
    if (route === "GET /symbols") {
      const { rows } = await pool.query(
        `SELECT ticker AS symbol, name, venue, tick_size_cents AS "tickSizeCents", lot_size AS "lotSize",
                status, reference_price_cents AS "referencePriceCents", price_band_pct AS "priceBandPct"
         FROM broker.securities ORDER BY ticker`,
      );
      return { status: 200, body: { symbols: rows } };
    }

    // ---- signed in ----
    const session = sessions.find(token);
    if (!session) return { status: 401, body: { text: "sign in first: Authorization: Bearer <token>" } };
    const account = session.accountId;

    if (route === "POST /deposits") {
      const { amountCents, reference } = await readJson(req);
      if (!Number.isSafeInteger(amountCents) || (amountCents as number) <= 0) {
        throw malformed("amountCents: a positive whole number of cents");
      }
      const ref = typeof reference === "string" && reference ? `${account}:${reference}` : ulid();
      const { posted } = await transaction(pool, (db) => creditCash(db, account, amountCents as number, ref));
      return { status: posted ? 201 : 200, body: { cashCents: await cashBalance(pool, account) } };
    }
    if (route === "GET /positions") {
      const { rows } = await pool.query<{ reserved: number }>(
        `SELECT coalesce(sum(reserved_cents), 0)::bigint AS reserved FROM broker.orders
         WHERE account_id = $1 AND status IN ('PENDING_NEW', 'NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL')`,
        [account],
      );
      const cashCents = await cashBalance(pool, account);
      const reservedCents = rows[0]?.reserved ?? 0;
      return {
        status: 200,
        body: {
          accountId: account,
          cashCents,
          reservedCents,
          buyingPowerCents: cashCents - reservedCents,
          holdings: await holdings(pool, account),
        },
      };
    }
    if (route === "POST /orders") {
      const { clientOrderId, request } = parseOrder(await readJson(req));
      const placed = await oms.place(account, clientOrderId, request);
      switch (placed.kind) {
        case "accepted":
          return { status: 201, body: orderView(placed.order) };
        case "replayed":
          return { status: 200, body: orderView(placed.order) };
        case "rejected":
          return { status: 422, body: orderView(placed.order) };
        case "refused": {
          const status = placed.reason === RejectReason.DUPLICATE_CLIENT_ORDER_ID ? 409 : 422;
          return { status, body: { status: "REJECTED", rejectReason: placed.reason, rejectText: placed.text } };
        }
      }
    }
    if (route === "GET /orders") {
      const { rows } = await pool.query<OrderRow>(
        "SELECT * FROM broker.orders WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100",
        [account],
      );
      return { status: 200, body: { orders: rows.map(orderView) } };
    }
    const id = url.pathname.split("/")[2] ?? "";
    if (route === "GET /orders/:id") {
      const { rows } = await pool.query<OrderRow>(
        "SELECT * FROM broker.orders WHERE order_id = $1 AND account_id = $2",
        [id, account],
      );
      if (!rows[0]) return { status: 404, body: { reason: RejectReason.UNKNOWN_ORDER } };
      const events = await pool.query(
        `SELECT event_type AS type, status, exec_id AS "execId", detail, created_at AS at
         FROM broker.order_events WHERE order_id = $1 ORDER BY event_id`,
        [id],
      );
      return { status: 200, body: { ...orderView(rows[0]), events: events.rows } };
    }
    if (route === "DELETE /orders/:id") {
      const result = await oms.cancel(account, id);
      if (result.kind === "requested") return { status: 202, body: orderView(result.order) };
      if (result.kind === "cancelled") return { status: 200, body: orderView(result.order) };
      const status = { UNKNOWN_ORDER: 404, TOO_LATE_TO_CANCEL: 409, VENUE_UNAVAILABLE: 503 }[result.reason as string] ?? 422;
      return { status, body: { reason: result.reason, text: result.text } };
    }
    return { status: 404, body: { text: `no route ${req.method} ${url.pathname}` } };
  }

  return createServer((req, res) => {
    handle(req, res)
      .catch((error: unknown) => {
        if (error instanceof HttpError) return { status: error.status, body: error.body };
        console.error(`api: ${req.method} ${req.url}: ${(error as Error).stack}`);
        return { status: 500, body: { text: "internal error" } };
      })
      .then(({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
  });
}
