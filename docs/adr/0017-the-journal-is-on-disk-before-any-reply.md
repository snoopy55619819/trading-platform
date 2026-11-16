# ADR 0017: The journal is on disk before any reply, and becomes the only save on the reply path

**Status:** proposed, 2026-11-16. Nothing built yet; the steps below are done in order, each
measured before the next.

## Context

Since ADR 0013 the gateway works in batches: it handles up to 512 events, saves every FIX
session that changed in one Postgres transaction, and only then sends the replies. The
promise behind that is "a client never receives a message the exchange could forget".

Checking that promise against the code found it holds for one kind of failure and not the
other:

| What fails | What survives | Is an answered order safe? |
|---|---|---|
| The gateway process crashes | Everything written to the operating system | **Yes** |
| The machine loses power, or the kernel panics | Only what reached the disk | **Not guaranteed** |

The reason is that the two saves on the reply path are not the same kind of save:

- **The journal** (`matching-engine/src/journal.rs`) writes each command and flushes it to the
  operating system, with no `fsync`. Its own comment says so, and leaves group commit as "a
  gateway-era decision". The data sits in the page cache for up to about 30 seconds before
  Linux writes it out.
- **Postgres** (in Docker on the same server and disk, default settings) does `fsync` its
  write-ahead log on every commit. It holds each session's sequence numbers and every
  outgoing message, kept for FIX resends (ADR 0010).

So after a power loss the gateway can come back with Postgres saying "execution report 812
was sent" while the journal no longer has the order it reported. The client holds an answer
for an order the exchange does not know about. On EC2 this needs a host failure, which is
rare, but it is exactly the case the word "durable" is meant to cover.

There is also a cost question. The one `fsync` on the reply path today is Postgres's, and a
round trip to Postgres is most of a batch's save time (ADR 0013). Two of the gateway's known
gaps sit in the same place (`crates/gateway/TODO.md`): reports of the last batch can be lost
in a crash between the journal and the save, and rejected client order ids are not journaled.

## Options

1. **Leave it, and say "safe against a process crash".** Honest and free. Leaves a gap in
   the one claim an exchange is judged on.
2. **`fsync` the journal on every command.** Simple and correct, but an `fsync` costs a
   millisecond or more on an EBS disk, so the exchange would be limited to roughly a
   thousand commands a second, below what it already does.
3. **Group commit: `fsync` the journal once per batch,** after the batch's commands are
   written and before the save and the replies. The batching already exists (ADR 0013), so
   this is one call in one place. Under load a batch holds many commands and the `fsync` is
   shared; at low load it adds one disk sync to each answer.
4. **Option 3, then make the journal the only thing saved on the reply path.** Rebuild FIX
   session state (sequence numbers, and the messages a resend needs) from the journal on
   recovery, so Postgres leaves the reply path. Each batch then costs one `fsync` and no
   database round trip.

## Decision

Option 4, in steps, each measured before the next:

1. **Measure the reply path as it is.** Time each part of a batch in the gateway (handling,
   journal writes, the Postgres save, handing out the replies) and report it with the
   other live numbers. On the server and in the load test. No behaviour changes.
2. **Group commit.** The journal gets a `sync()` (`File::sync_data`); the core calls it once
   per batch, before saving the sessions and before anything held is sent. A failed sync is
   fatal, like a failed write. After this, "on disk before any reply" is true for every
   failure above. Measure the cost; it is expected to be small under load and about one
   disk sync (1 to 2 ms on gp3) at low load.
3. **The journal records what the FIX sessions need,** and Postgres leaves the reply path.
   Two ways to do it, to be chosen with the step 1 numbers in hand and recorded here:
   - **Rebuild on replay.** Execution reports are already deterministic from the journal
     (their ExecIDs come from journal sequence numbers). What is missing is time: replay
     needs each command's arrival time in the journal, so `TransactTime` and `SendingTime`
     come out the same. Session-level messages (logons, rejects of malformed messages) would
     be journaled too, as small entries.
   - **Journal the outgoing messages themselves** in the gateway's own append-only file,
     synced in the same group commit. More bytes, no rebuilding logic.

   Either way the session store in Postgres becomes a cache written after the replies are
   sent, or goes away. The crash window and the forgotten rejected ids in the gateway's TODO
   close with it.
4. **Find the ceiling with a load generator built for it,** separate from the simulator. The
   simulator makes a realistic market and levels off near 520 transactions a second
   (`docs/SCALE-PLAN.md`, stage 5); a generator that only sends orders and cancels over FIX
   shows what the exchange itself can take. Run it on the same instance type as production
   (a temporary server costs money, so that is asked for first).

The live site keeps running at a realistic rate (`docs/SCALE-PLAN.md`, stage 7). The peak
from step 4 and the live rate are reported as two different numbers.

## Consequences

- **The durability claim becomes exact.** Until step 2 ships, documentation says "survives a
  process crash"; after it, "on disk before any reply".
- **Step 2 adds latency at low load** (one disk sync per answer) and almost none under load.
  Step 3 is where the time is won back, by removing the Postgres round trip.
- **Recovery changes in step 3,** and recovery is what the conformance test's crash and
  restart check covers (`exchange-alpha/conformance/run.sh`). It must pass unchanged, and
  replay must stay byte-identical (`CLAUDE.md`).
- **The journal grows** if it carries arrival times or outgoing messages. Finished days are
  already gzipped and moved to S3 nightly (ADR 0012, stage 3); the growth is measured in
  step 3.
- **The exchange's Postgres stays** for whatever is not on the reply path, and may end up
  with nothing to do. Removing it would be its own change.
