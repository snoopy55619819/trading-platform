/**
 * broker-market-data — the broker's market data service.
 *
 * Owns the whole market data concern on the broker side, both halves:
 *
 *   live     subscribes to Alpha Exchange's feed and fans out over WebSocket to `web`
 *   history  persists every tick, rolls up 1m/5m/1h/1d candles, serves them over REST
 *
 * Deliberately independent of `backend`:
 *   - its own database (not a schema in the backend's) — it is headed for a columnar
 *     time-series store, and that migration must not require touching another service
 *   - its own vendored copy of the exchange spec, in ./vendor/exchange-alpha
 *   - no shared code with the backend, so this service could be rewritten in Go or Rust
 *     and nothing else would change
 *
 * It lives on the PUBLIC market data plane, which is anonymous by construction: it never
 * sees an account id or a client order id, and has no way to learn whose order moved the
 * book. That is why it needs nothing from the backend's domain types.
 *
 * Built at milestone 7. Its database arrives with it — creating one now would be empty
 * infrastructure with no caller.
 */

export const SERVICE_NAME = "broker-market-data";

/** Candle intervals served over the history API. */
export const INTERVALS = ["1m", "5m", "1h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];
