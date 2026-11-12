# Newswire protocol, spec 1.1.0

What the newswire publishes, for anyone building a client. Fictional companies, fictional
news. A client vendors this folder and implements against it, as it does the exchange's
spec; it never imports the newswire's code.

| File | What it is |
|---|---|
| `newswire.json` | the version, where to connect, and every category with its tone |
| `headline.schema.json` | a headline's shape, as JSON Schema |

## A headline

```json
{
  "id": "01JCQ8S7Y4M3V9X2K5T6R1B0AZ",
  "ts": "2026-11-12T14:03:12.481Z",
  "symbol": "ACME",
  "headline": "Acme Industrial Corp misses estimates by a wide margin",
  "body": "Acme Industrial Corp reported third-quarter earnings of $1.42 a share, short of the $1.81 analysts had expected. Revenue fell 6.2% from a year earlier to $812 million. \"We did not execute as well as we should have this quarter,\" its chief executive said.",
  "category": "EARNINGS_MISS",
  "tone": "NEGATIVE",
  "severity": "MAJOR"
}
```

- `id`: a ULID, unique. Use it to drop repeats.
- `ts`: when it was published: ISO 8601, UTC, milliseconds.
- `symbol`: a ticker Alpha Exchange lists. The wire writes only about active listings.
- `headline`: one sentence with the company's full name, no trailing full stop.
- `body`: the story under the headline, a few sentences (at most 1,000 characters). Its
  figures are invented but consistent with the headline: a major miss misses by more.
  Optional: added in 1.1.0, so a client must cope without it.
- `category`: the kind of story. The list is in `newswire.json`.
- `tone`: `POSITIVE`, `NEGATIVE` or `NEUTRAL`, the wire's own reading. Each category always has
  the same tone.
- `severity`: `MINOR` or `MAJOR`, how big a surprise it is. Neutral stories are always `MINOR`.

There is no price impact in a headline. What a story is worth is each reader's own call.

## Live: WebSocket

`ws://<host>:9890/headlines`. Each headline arrives as one JSON text message as it is
published. Clients send nothing.

A client that falls too far behind (about 1 MB unsent) is disconnected. It should reconnect
and catch up.

## Catch-up: HTTP

`GET http://<host>:9890/headlines?since=<ISO 8601 time>` returns

```json
{ "headlines": [ ... ] }
```

with the headlines published **at or after** that time, oldest first, from the last 1,000 the
wire keeps in memory. A missing or unreadable `since` is a `400`.

**To miss nothing:**

1. Open the WebSocket.
2. Fetch `GET /headlines?since=` with the time of the newest headline you already have (or
   any time in the past, the first time).
3. Keep every headline whose `id` you have not seen, from either source.

The overlap between the two is harmless, because ids repeat exactly.

**After the wire restarts** it has no history: a catch-up returns only what was published
since. Clients that need older news keep their own copy.

## Health

`GET /health` returns `{ "ok": true, "clients": <open WebSockets> }`.

## Versioning

`spec_version` in `newswire.json` follows semver. Adding a category or an optional field is a
minor version: clients must accept categories they do not know (treat them by `tone`).
Removing or renaming anything is a major version.

- **1.1.0:** adds the optional `body`.
- **1.0.0:** the first version.
