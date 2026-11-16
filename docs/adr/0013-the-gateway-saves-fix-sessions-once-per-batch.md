# ADR 0013: The gateway saves its FIX sessions once per batch, and sends only what is saved

**Status:** accepted, 2026-11-15. Built in the gateway (`core.rs`, `store.rs`). Stage 2 of
`docs/SCALE-PLAN.md` (ADR 0012).

## Context

The first load test (ADR 0012, stage 1) found the exchange answering slowly long before any
process was busy: about 70 transactions a second within a 50 ms 99th percentile, and nothing
past about 1,200 a second, with the busiest process at 18% of a core.

The cause was in the gateway's core loop. It handled one event (usually one incoming FIX
message), then saved every FIX session that changed: a Postgres transaction with one
`INSERT` per outgoing message. Only then did it look at the next event. Every message
waited behind the saves of all the messages ahead of it, about 0.8 ms each, so a burst of
twenty orders took about 16 ms to answer, and about 1,200 saves a second was the most it
could ever do. Turning off Postgres's commit flush made no difference: the time was round
trips, not the disk.

A second, older problem sat in the same place: replies were handed to the connection before
their save. A crash between the two meant a client had a message the exchange had no record
of, and after restarting the exchange would give a different message the same sequence
number.

## Options

1. **Keep a save per message, but make it cheaper** (one multi-row `INSERT`). Fewer round
   trips per save, but still one save per message: the ceiling barely moves.
2. **Batch:** handle whatever events have already arrived, save once, then send. A save costs
   about the same for one message or hundreds, so the busier the exchange, the cheaper each
   message.
3. **Save in the background** and never wait for it. Fastest, but a crash loses messages
   clients already have, which is the problem above made worse.
4. **Keep the resend store in memory only** for sessions that reset on every logon (the
   simulator). Removes the cost for one client, needs a per-client setting, and does nothing
   for the broker.

## Decision

Option 2, with option 1 inside it.

- **The core handles a batch, then saves once.** It waits for one event, then takes every
  event already queued, up to 512, then saves each changed session in one transaction. At low
  load a batch is one event, as before; under load it grows by itself.
- **Replies wait for their save.** What the core says to a connection (messages, and closing
  it) is held until the batch is saved, then sent in order. A client never receives a message
  the exchange could forget. The cost is one save per batch, about a millisecond.
- **A save is a fixed handful of statements:** the sequence numbers, the resend window's
  delete (ADR 0010), and every new message in one `INSERT ... SELECT FROM UNNEST(...)`.
- Option 4 stays available if the simulator's resend store ever matters again.

## Consequences

- **Measured with the load test** (locally; `docs/SCALE-PLAN.md`, stage 2): the 99th
  percentile answer at 111 transactions a second went from 60 ms to 9 ms; about 860 a second
  answers in 31 ms and about 1,460 in 43 ms, where before nothing got past about 1,200 at any
  latency. Up to 5,181 a second were accepted with the gateway at 19% of a core; beyond about
  1,500 the simulator's market makers, not the exchange, are what fall behind.
- **What clients see is unchanged:** the same messages, numbers and order. Only their timing
  changes, and a message now always reaches a client after it is saved.
- **The crash window the gateway's TODO lists remains:** a command is journaled before its
  reports are saved, so a crash between the two still loses the reports for one batch. That
  needs reports rebuilt from the journal on recovery, and is not changed here.
- `PgStore` now has its own test against a real database, run when
  `ALPHA_TEST_DATABASE_URL` is set.
