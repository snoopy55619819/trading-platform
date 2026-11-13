# market-simulator — Milestone 4

**Makes the market look alive when nobody is using the app.** Without it, v1 is an empty
book and a flat chart.

Status: **done** · 56 tests, plus behaviour runs against the real exchange. Trades on the
newswire's headlines since stage 3 of the news plan (ADR 0006).

```
pnpm install && pnpm proto:gen      # once: dependencies, and TypeScript from the vendored proto
pnpm start                          # needs the exchange running (FIX 9878, feed 9879); news from the newswire (9890)
pnpm test                           # FIX codec and session, mirror, price model, agents, orders
pnpm realism                        # how realistic the live market's prices are (ADR 0008)
```

## Inputs / outputs

| | |
|---|---|
| **In** | The public market data feed — agents watch the book like anyone else |
| **In** | Headlines from the newswire, over its published protocol (`vendor/newswire/`) |
| **Out** | Orders over FIX, through the **same public gateway** a real client uses |
| **Owns** | Per-agent state in memory: fair value estimate, inventory, PnL, live quote ids |

**No backdoor into the engine.** The simulator is just more FIX clients. That is exactly
what makes it a valid test of the whole system rather than a rigged demo — and it means
the gateway is under continuous load from this milestone onward.

## Settings

All optional, by environment variable (`src/config.ts`):

| Variable | Default | |
|---|---|---|
| `SIM_MAX_ORDERS_PER_SEC` | `40` | ceiling on orders and cancels, every agent together (the deployed instance uses `80`) |
| `SIM_ACTIVITY` | `1` | how often the takers trade; below 1 for a quieter market (the deployed instance ran at `0.2` until ADR 0005, then `1`, now `2`) |
| `SIM_IMPACT` | `1` | how hard trading moves the price, as a multiple of the model's (`src/market/model/impact.ts`, ADR 0008); `0` turns it off |
| `SIM_SPEED` | `1` | fair value runs this many times faster than the clock, to see hours in minutes |
| `SIM_SEED` | the clock | the same seed replays the same price paths |
| `SIM_REPORT_SECS` | `30` | how often the status table prints |
| `SIM_COMP_ID` | `SIM` | must be in the exchange's `ALPHA_COMP_IDS` |
| `SIM_SESSION_RESET_EVERY_SECS` | `0` | also start the FIX session over this often; `0` means only daily, at the venue's roll |
| `SIM_FIX_HOST` / `SIM_FIX_PORT` / `SIM_FEED_URL` | from `listings.json` | where the venue is |
| `SIM_NEWS_URL` | from `newswire.json` | the newswire's WebSocket; empty to trade without news |

## Checklist

### 1. Plumbing
- [x] Vendor the venue spec (`fix44.xml`, `marketdata.proto`, `listings.json`), added to
      the root `spec:sync` / `spec:check`
- [x] Vendor the newswire's spec (`newswire.json`, `headline.schema.json`, `README.md`) the
      same way, and subscribe: WebSocket, catch-up from the newest headline, repeats dropped
- [x] FIX initiator — a TypeScript one, independent of the Rust acceptor
- [x] Subscribe to the market data feed with gap detection (`symbol_seq`, then resync)
- [x] Per-agent FIX sessions, or one session with distinct account ids: **one session,
      an account per agent** (see Decisions)

### 2. Price process
- [x] Hidden fair value per symbol on a geometric Brownian motion, seeded from
      `reference_price_cents`
- [x] Per-symbol drift and volatility (HELX should move far more than GRID)
- [x] Occasional jumps ("news"), or charts look like noise around a flat line. Since ADR
      0006 these come only from the newswire's headlines: see "News" below
- [x] Diurnal multiplier on volume and volatility, so there are quiet and busy hours
- [ ] More realistic prices, in layers and measured (ADR 0008): the plan and its stages are
      in [PRICE-MODEL.md](PRICE-MODEL.md). Stages 1 (layers, measurement, baseline) and 2
      (trading moves the price) are built.

### 3. Agents
- [x] **Market maker** — quotes both sides around fair value; spread widens with
      volatility; **inventory skew** (long → shade quotes down to offload); pulls quotes on
      a large adverse move.
- [x] **Noise trader** — Poisson arrivals, random side, small market orders
- [x] **Momentum** — chases short-term moves; creates trends
- [x] **Mean reversion** — fades extremes; creates the pullbacks
- [x] Global rate control, so you can dial total order volume down for a deployed instance

### 4. Behaviour checks
- [x] The spread stays sane — it should not collapse to zero or blow out permanently
- [x] Price wanders without exploding or flatlining over a long run
- [x] Market makers end roughly flat rather than accumulating unbounded inventory
- [x] The 1-minute chart looks like a real stock to the eye

### 5. Daily session reset (post-MVP, before deployment)
- [x] At the venue's business-date roll (`business_date_roll_utc`, 21:00 UTC) the simulator
      pauses its agents, cancels everything resting, logs out and logs straight back on.
      Every logon resets sequence numbers, and the exchange drops the copies it keeps of a
      session's messages for resends only when that session resets. The simulator never
      logged off on its own, so those copies grew by roughly 250 MB a day.
      Cancelling first means nothing can trade while it is away, so no fill is lost.
      Checked against a real gateway with `SIM_SESSION_RESET_EVERY_SECS=8`: the messages
      stored for the session fell from about 160 to 1 at each reset, with one clean logout
      and logon each time. `src/fix/daily-reset.ts`, `test/daily-reset.test.ts`.

## Done when

The book is alive 24/7 and the depth ladder and chart look like a real market.

**Met**, by two 12-minute runs against the real exchange at `SIM_SPEED=20` (about four
hours of price action), same seed, with an independent recorder on the public feed taking
the top of every book each second and every print.

The first run failed the behaviour checks, which is what they were for:

| | first run | after the fixes |
|---|---|---|
| seconds a book had only one side, worst symbol | 287 of 721 | 9 of 721 |
| peak market-maker inventory, against its limit | 103% to 114% | 41% to 78% |
| crossed or zero spreads | 0 | 0 |
| rejects / feed gaps | 0 / 0 | 0 / 0 |
| mean-reversion P&L (it barely traded at first) | $38 | +$10.6k |

What changed: market makers replace a quote at once instead of waiting for the cancel to be
confirmed (waiting left whole sides empty); what rests on a side must fit the inventory room
left, with one lot kept at the touch until 1.5x the limit; inventory skews harder; signal
traders warm up for a minute instead of up to ten. The seconds still one-sided are startup,
shutdown, and the deliberate pulls on news jumps.

Prices moved from under 1% (GRID) to 14% (CRUX, HELX) over the four simulated hours, with trends, pullbacks
and gaps on news; spreads held at a few cents for the cheap names and tens of cents for
CRUX ($286, wider here because of the 20x speed). Momentum lost money and mean reversion
made it, the usual outcome in a market whose fair value is anchored. The run journaled
about 15,000 commands (21 a second).

## Design

```
                fair value (hidden)          public feed (WebSocket)
                       │                            │
                market makers                momentum · mean reversion · noise
                       └──────────────┬─────────────┘
                                   Orders  ── rate limit ──  one FIX session (SIM)
```

- `src/fix/` is the FIX initiator: `codec.ts` (framing, checksums, exact cents), a pure
  `session.ts` state machine (logon, heartbeats, test requests, gap detection, resend
  requests, gap fills), and `connection.ts`, the socket with reconnect and backoff. It shares
  nothing with the exchange's Rust: `test/tags.test.ts` checks every tag number against the
  vendored `fix44.xml`, and the live runs are the interoperability test.
- `src/feed/` subscribes to every symbol and keeps a `Mirror` per symbol, following the
  spec's rules: snapshot first, `symbol_seq + 1` applied, a skip makes the book stale and
  asks for a resync.
- `src/market/fair-value.ts` is the price model: a random walk with layers on top
  (`src/market/model/`, ADR 0008); `diurnal.ts` the time of day. `realism/` measures how
  real the resulting prices look.
- `src/agents/` holds the four agent kinds. Only market makers see fair value (it stands
  in for their information); the others trade on public prices.
- `src/orders.ts` tracks the firm's own orders by ClOrdID, routes fills to the owning
  account, and holds the rate limit. Positions are built from fills alone.

## Decisions

- **One FIX session, an account per agent** (`MM-ACME`, `NOISE`, `MOMENTUM`, `MEANREV`).
  Alpha's self-trade prevention works per account, so the desks trade with each other as
  separate desks at one firm would. One session is how a real firm connects, and it means
  one CompID on the allowlist and one sequence-number state.
- **Every logon resets sequence numbers, and then cancels everything that might still
  rest.** A simulator would rather start clean than reconcile. Reports sent while it was
  away are lost, so a fill it missed is never booked; a real broker could not accept that
  (its initiator, M6, must recover by resend). Within a connection the full session rules
  still apply.
- **Open orders are saved to `data/open-orders.json` every second**, written to a
  temporary file and renamed. After a crash the next run cancels them on logon. A crash
  can still orphan up to a second's worth of new orders.
- **Resend requests are answered with a gap fill, never by resending orders.** A stale
  order delivered late could trade at a price nobody wants any more.
- **Fair value is weakly pulled toward the reference price** (half-life 3 days) and kept
  within 75% of the price band. The venue's band is anchored on the static
  `reference_price_cents`, so a free random walk would eventually leave it and every order
  would be rejected. The pull is too weak to see within a day.
- **Fair value is the only floating-point price.** It is a model quantity; every price that
  leaves it is rounded to integer cents on the symbol's tick, and FIX prices are formatted
  and parsed from integer cents without a float.
- **Cancels skip the rate limit's queue** (they may overdraw it). Pulling a quote is never
  the thing to delay.
- **Takers use marketable limits, not unbounded market orders**, except noise traders,
  whose orders are small. A momentum order cannot sweep the book.
- **News** (`market/news.ts`, ADR 0006). The newswire says what happened; what it is worth
  is this firm's model:
  - **A new level.** Fair value moves once, up for positive news and down for negative, by
    `dailyVol × jumpSize × 0.3` for `MINOR` news and `× 0.75` for `MAJOR`, give or take
    30%. For ACME that is about 1.1% and 2.8%. Neutral news moves nothing. The sizes are
    calibrated so a day of news adds as much volatility as the random jumps it replaced
    (2 a day, each a standard normal times `dailyVol × jumpSize`): the wire sends 5 times as
    many moving stories, so each is smaller. A test holds it to that.
  - **A burst.** The symbol's heat starts at 1 (major), 0.6 (minor) or 0.2 (neutral) and
    halves every 2 minutes of wall-clock time, also under `SIM_SPEED`. At full heat fair
    value moves 4 times as fast, takers trade 5 times as often with shorter cooldowns and
    twice the size, and market makers show half their size. Their spread widens by itself,
    since it follows volatility.
  - **Pulling.** A move sets `jumped` for one step, so the market makers cancel and pause
    as before, and the first trades happen at the new price.
  - **Without the wire** the simulator logs it once, trades without news, and reconnects
    with backoff. Catch-up starts from when the simulator started, so news it was not
    running for is never traded on.
  - Checked against the real stack at `NEWS_RATE=20`: a minor JOLT regulator story moved
    fair value down 1.02%, its market maker pulled once, and JOLT printed 20 trades that
    minute against 2 to 6 in the minutes around it.

## Known gaps

- **The exchange's storage grows without limit under 24/7 load.** Every command is
  journaled and every report kept in `fix_outbound`; neither is ever compacted. Fine for
  development; a deployed instance needs journal snapshots and outbound pruning first.
- **Market makers know fair value exactly.** Real ones estimate it. Good enough for a
  market that looks right; an "informed trader" agent would be the honest version.
- **No ClOrdID memory across a crash beyond the run id.** IDs are `{run id}-{n}`, the run id
  being the start time in base 36, so two runs started in the same millisecond would clash.
