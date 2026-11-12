# ADR 0006: News comes from a newswire, and moves the simulated market

**Status:** accepted, 2026-11-12. Being built in stages (`participants/newswire/TODO.md`):
the newswire writes a short story under each headline, the simulator trades on it, the
broker's market-data stores and serves it, and the web app shows it. It is not deployed yet. Changes who decides when a symbol's price jumps: today the
simulator does, alone and silently (`market/fair-value.ts`).

## Context

The web app has prices, a chart, depth and the tape, but nothing that says *why* a price
moved. A trading screen without news feels empty, and news is the thing that explains a
chart.

The market is synthetic. The ten listed companies are invented (`exchange-alpha/spec/
listings.json`), so real news cannot describe them: an Apple headline next to ACME's chart
means nothing.

The simulator already models news without showing it. Each symbol's hidden fair value takes
occasional random jumps, one to four a day depending on the company, and the market makers
pull their quotes when one happens. Nobody outside the simulator can see that anything
happened, only that the price gapped.

Three facts shape the choice:

1. **Companies only meet over published protocols.** The exchange publishes a spec; the
   broker and the simulator vendor a copy and implement their side. News should work the
   same way.
2. **A trading firm does not write news.** If the simulator produced headlines, the broker
   would be reading news from a trading firm, which no real market does.
3. **News should cause the move, not describe it afterwards.** The useful part is the chain
   a viewer can follow: a headline, then the market makers repricing, then trades, then a
   gap on the chart.

## Options

**Where headlines come from:**

1. **A real news API.** Real wording, but it describes real companies, not ours. It also
   costs money and needs keys.
2. **Headlines written by an LLM.** Natural wording, but a paid call per headline and an
   outside dependency for something templates do well.
3. **Templates in a new newswire participant.** A catalogue of story types (earnings beat,
   analyst downgrade, product recall...), filled in with the company's name. Free,
   predictable and testable.

**Who owns it:**

4. **Inside the simulator:** the simulator makes its jumps, then announces them. One less
   process, but news would come from a trading firm (fact 2), the broker would connect to
   the simulator, and news would stop whenever the simulator restarts.
5. **A separate participant, `participants/newswire/`:** its own process and container. The
   simulator and the broker both subscribe to it, as clients of its published protocol.

**What news does to the market:**

6. **A jump in fair value only,** as today. The price gaps, then carries on as if nothing
   happened.
7. **A burst of activity only:** more trades and wider swings for a few minutes. Without a
   new price level the burst is noise that drifts back, and the headline meant nothing.
8. **Both:** a lasting move to a new level, sized by the story, plus a burst that fades over
   a few minutes. The chart shows a gap, choppy overshooting while traders react, then calm
   at the new level: the shape real news makes.

**What the wire says about size:**

9. **The wire publishes the price impact** ("-4%"). Simple, but no real news service does
   that, and every firm would react identically.
10. **The wire publishes what happened; each firm decides what it is worth.** The wire says
    the category (an earnings miss), the tone (negative) and how big a surprise it is
    (minor or major). The simulator turns that into a move with its own model, scaled by
    the company's volatility: a biotech moves more on the same story than a utility.

## Decision

Options 3, 5, 8 and 10.

- **A newswire participant** in `participants/newswire/`, its own process and container on
  the same server. It owns the schedule: when each company has news, and what kind.
- **It publishes a spec** in `participants/newswire/spec/`, vendored by its two clients like
  the exchange's: live headlines over a WebSocket, and `GET /headlines?since=` to catch up
  after a reconnect. Clients deduplicate by headline id, so a catch-up that overlaps live
  messages is harmless.
- **The simulator follows the wire.** Its own random jumps go away, so every gap has a
  headline behind it. On a moving headline it shifts fair value to a new level and starts a
  burst that fades with a half-life of about two minutes: more taker orders, larger ones,
  faster fair value movement, and market makers quoting wider and smaller. A neutral
  headline gives a small burst and no level change.
- **The broker's market-data service stores news** in its own database, serves it, and pushes
  new headlines over the WebSocket the web app already uses. The web app shows a News panel
  and marks headlines on the chart.

Options 1 and 2 were rejected on fit and cost. Option 4 was the simpler deployment, but it
breaks the company split for the sake of one small container. Option 9 was rejected because
it makes every firm's reaction the same and no real wire works that way.

## Consequences

- **A fourth company,** with its own folder, spec, image, compose file and CI job. It runs as
  one more small Node process, about 50 MB of memory, on the existing server: no extra AWS
  cost. It has no database: it keeps recent headlines in memory for catch-up, and the
  broker is the one that stores them.
- **The simulator depends on the wire for price jumps.** If the wire is down, the market
  still moves (the random walk and the pull toward the reference price stay) but has no
  news. That is acceptable for a demo, and the simulator logs it.
- **Busier news than today's jumps:** about one moving headline per symbol every 2 to 3 hours
  on average, plus a similar number that move nothing, scaled per company (more for the
  biotech, fewer for the utility). Across ten symbols that is a story every 5 to 10 minutes.
- **Bursts are capped** by the simulator's ceiling of 40 orders a second
  (`SIM_MAX_ORDERS_PER_SEC`). A burst flattens there, which is a reasonable limit, and the
  "closer to real market speed" backlog item can raise it.
- **Bursts stay inside the price band.** Fair value is already kept within 75% of the venue's
  band, so big news cannot push orders into rejection.
- **Storage is negligible:** a few hundred short headlines a day.
- **News is public broadcast,** like market data: it reaches the web app through
  market-data, never through the order path. The architecture diagrams in
  `docs/architecture/` gain the newswire once it is built.
