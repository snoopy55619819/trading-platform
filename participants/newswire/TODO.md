# Newswire: plan

A news service for the synthetic market. It invents headlines about the listed companies and
publishes them. The simulator trades on them, and the broker stores them and shows them in
the web app. Why it is a separate participant, and why news moves prices, is in
[ADR 0006](../../docs/adr/0006-news-from-a-newswire-participant.md).

Stages 1 to 4 are done: the newswire publishes, the simulator trades on it, and the broker's
market-data stores and serves it. The web app does not show it yet. Each stage below is one
PR.

## The flow

```
newswire ──headlines──▶ simulator ──orders (FIX)──▶ exchange ──feed──▶ market-data ──▶ web
    │                    (fair value jumps,                              ▲
    │                     a burst of trading)                            │
    └──────────────────────────headlines─────────────────────────────────┘
```

The headline reaches the simulator and the broker at the same moment. The price moves
because simulated traders react to it, over the same public FIX path as any client.

## Inputs and outputs

- **In:** the exchange's `listings.json` (tickers and company names), vendored under
  `participants/newswire/vendor/exchange-alpha/` and kept current with `spec:sync`, like the
  simulator's copy.
- **Out:** headlines, over the protocol below. The spec lives in `participants/newswire/spec/`;
  the simulator and market-data vendor it.

## The protocol (spec 1.0.0)

**A headline:**

```json
{
  "id": "01JF...",
  "ts": "2026-11-12T14:03:12.481Z",
  "symbol": "ACME",
  "headline": "Acme Industrial Corp misses third-quarter estimates",
  "category": "EARNINGS_MISS",
  "tone": "NEGATIVE",
  "severity": "MAJOR"
}
```

| Field | Meaning |
|---|---|
| `id` | a ULID, unique; clients deduplicate on it |
| `ts` | when it was published, UTC, milliseconds |
| `symbol` | one listed ticker |
| `headline` | the text, one sentence, no trailing period |
| `category` | the kind of story (catalogue below) |
| `tone` | `POSITIVE`, `NEGATIVE` or `NEUTRAL`: the wire's own reading, decided by the category |
| `severity` | `MINOR` or `MAJOR`: how big a surprise. Always `MINOR` for neutral stories |

There is deliberately no price impact. What a story is worth is each firm's call.

**Live:** a WebSocket at `ws://<host>:9890/headlines`. The server sends each headline as one
JSON text message as it is published. Clients send nothing.

**Catch-up:** `GET /headlines?since=<ISO time>` returns the headlines published after that
time, oldest first, up to the last 1,000 kept in memory. A client opens the WebSocket first,
then fetches from the time of the newest headline it has, and drops any id it has already
seen. Nothing is lost across a reconnect, and an overlap is harmless.

**After a restart** the wire starts with no history. That is fine: it has no clients that
need older news than they already stored.

## The catalogue

Each category has a tone and several wordings, with stronger words for `MAJOR`.

| Tone | Categories |
|---|---|
| Positive | `EARNINGS_BEAT`, `GUIDANCE_RAISED`, `ANALYST_UPGRADE`, `CONTRACT_WIN`, `PRODUCT_APPROVAL`, `BUYBACK` |
| Negative | `EARNINGS_MISS`, `GUIDANCE_CUT`, `ANALYST_DOWNGRADE`, `PRODUCT_RECALL`, `EXECUTIVE_DEPARTURE`, `REGULATORY_PROBE` |
| Neutral | `CONFERENCE`, `DIVIDEND_DECLARED`, `EXECUTIVE_APPOINTED`, `ANNUAL_MEETING`, `INDEX_REVIEW` |

Examples, for ACME:

- `EARNINGS_BEAT`, minor: "Acme Industrial Corp edges past quarterly estimates"
- `EARNINGS_BEAT`, major: "Acme Industrial Corp smashes estimates as orders surge"
- `ANALYST_DOWNGRADE`, minor: "Analyst trims Acme Industrial Corp to neutral"
- `CONFERENCE`: "Acme Industrial Corp to present at industrials conference next week"

A few categories suit some companies more than others (`PRODUCT_APPROVAL` for the biotech).
Per-company weights handle that.

## The schedule

- Each symbol has news at random times (a Poisson process), on average once every 2 to 3
  hours for a story that moves the price, plus about as many neutral ones.
- **Per-company rates,** in a small table in the newswire's own config, as the simulator's
  per-symbol profiles are today: HELX (biotech) about twice the base, GRID (utility) and JOLT
  (consumer staples) about half, the rest at the base.
- About one moving story in four is `MAJOR`.
- Positive and negative are equally likely, so news has no drift. The pull back toward the
  reference price keeps prices in the band either way.
- **Seeded:** the same `NEWS_SEED` gives the same stories at the same times, for tests.

**Settings:**

| | | |
|---|---|---|
| `NEWS_PORT` | 9890 | where it serves |
| `NEWS_RATE` | 1 | multiplies every rate: 20 to see a story every few seconds while testing |
| `NEWS_SEED` | random | as above |
| `NEWS_LISTINGS` | vendored file | the listings to read |

**As built:** each symbol has a moving story 10 times a day at the base rate (one every 2.4
hours) and a neutral one 10 times a day, so about one story per company every 70 minutes.
HELX is at 2 times the base, GRID and JOLT at half. A quarter of moving stories are `MAJOR`.
The rates and the weights per category are constants in `src/schedule.ts` and
`src/catalogue.ts`.

## How the simulator reacts

On each headline for a symbol it trades:

1. **A new level.** Fair value moves once, up for positive news and down for negative, by
   about `dailyVol × jumpSize × size`, where size is 0.3 for `MINOR` and 0.75 for `MAJOR`,
   give or take 30%. Neutral news moves nothing. (Planned as 0.6 and 1.5; halved when built,
   because the wire sends 5 times as many moving stories as the old random jumps, and the
   total should add the same volatility. `participants/simulator/TODO.md` has the
   arithmetic.)
2. **A burst.** Each symbol gets a "heat" that starts at 1 for major news, 0.6 for minor and
   0.2 for neutral, then halves every 2 minutes, so it is mostly gone after 10. While it is
   warm:
   - takers trade more often (up to about 5 times at full heat) and in larger sizes;
   - fair value moves faster (up to about 4 times its normal volatility), so traders
     overshoot and pull back;
   - market makers quote wider, because their spread already follows volatility, and
     smaller.
3. **Market makers pull first.** They already cancel and pause on a jump, so the first
   trades after a story happen at the new price, not the stale one.

Its own random jumps (`jumpsPerDay` in `config.ts`) are removed: every gap has a story. If the
wire cannot be reached the simulator logs it, keeps trading without news, and reconnects.

The simulator's 40 orders a second ceiling still applies. A big burst flattens there.

## How the broker shows it

- **market-data** subscribes like the simulator. It stores each headline in a new `news`
  table, keyed on `id`, so a repeat is ignored. It serves `GET /news?symbol=&limit=` (newest
  first; no symbol means every symbol), and pushes each new headline to every web client over
  the existing live WebSocket as `{ "type": "news", ... }`. Retention: forever. It is tiny.
- **web:**
  - **A News panel:** the latest headlines with time, ticker and a green or red marker for
    tone, either for the selected symbol or for all symbols. Clicking a headline selects its
    symbol. It goes into every style's layout.
  - **On the chart:** a small marker on the candle where each of the selected symbol's
    headlines landed, beside the high and low marks, using the same series markers.

## Stages

Each stage is one PR, with its tests and docs.

1. [x] **Plan and ADR:** this file and ADR 0006 (PR #42).
2. [x] **The newswire:** (PR #43)
   - the spec (README and a JSON schema for a headline) in `spec/`;
   - the service: the catalogue, the scheduler, the WebSocket and `GET /headlines`;
   - vendored listings with `spec:sync`;
   - unit tests for the catalogue, the scheduler (seeded) and the catch-up;
   - added to `pnpm dev` and `docs/RUNNING.md`;
   - its own CI job (moved here from stage 6: tests should run from the start).
3. [x] **The simulator follows the wire:** (PR #44)
   - vendor the newswire spec and subscribe, with catch-up on reconnect;
   - the new level and the burst, as above, replacing `jumpsPerDay`;
   - tests: news moves fair value the right way, heat decays, neutral news moves nothing.
   - **Check:** a run with `NEWS_RATE=20` shows gaps and bursts that line up with headlines.
4. [x] **market-data stores and serves news:**
   - vendor the spec;
   - a migration for `news`;
   - the subscriber with catch-up;
   - `GET /news` and the live push;
   - tests against Postgres.
5. [ ] **The web app:**
   - the News panel in every style;
   - chart markers;
   - tests for any new pure logic;
   - screenshots.
6. [ ] **Deploy:**
   - a Dockerfile, and `participants/newswire/deploy/compose.yml` on the `trading` network
     (its port is not published to the internet);
   - the image in CI and the deploy workflow;
   - the newswire in `docs/DEPLOYMENT.md` and the architecture diagrams;
   - a release.

## Done when

A headline appears in the web app's News panel, the chart gaps at that moment in the
direction the story says, and the tape shows a burst of trading that calms down over the
next few minutes, all on the live server.
