# ADR 0009: The server keeps only the images in use, and scaling waits on the exchange's memory

**Status:** accepted, 2026-11-15. Decision 1 was done once by hand and goes into the deploy
agent (`hosting/deploy-agent.sh`) in the PR after this one; decision 2 is the work after
that. No company's code changes here.

## Context

After `v0.5.6` (the realistic price model, ADR 0008) had run for two days at
`SIM_ACTIVITY=2`, the question was whether the server could take more: a busier simulator,
and a deeper order book. Measured on 2026-11-15 (SSM, CloudWatch, Cost Explorer):

| | Measured | Verdict |
|---|---|---|
| CPU | 5.6 to 7.5% on average over four days, peaks about 23%; CPU credit balance full (576) | about three times the room |
| Cost | $0.44 of usage this month, covered by credits; no CPU surplus charges | stable |
| Simulator | 1.56 million orders since release, 0 rejects, 0 feed gaps, 14 throttled | healthy |
| Exchange journal | about 230 MB a day (82 MB on the day before activity 2); archived nightly | fine |
| Disk | 44% of 30 GB, up from 31% two days earlier | **growing too fast** |
| Gateway memory | 249 MB in memory plus 538 MB in swap, after 41 hours and two daily rolls | **growing** |
| Exchange database | 613 MB, almost all `fix_outbound`: 264,000 rows 3.6 hours after the roll | **growing through each day** |
| Server memory | 708 MB available, 896 MB of swap in use | **tight** |

Three things stood out:

1. **Old images were filling the disk.** 63 images, 5.5 GB of them not used by any
   container. The deploy agent ran `docker image prune`, which only removes images with no
   tag; every release's images keep their version tag, so each release left about 1 GB
   behind. At that rate the disk alarm (80%) would fire in about ten releases.
2. **The gateway's memory did not come back down at the daily roll.** ADR 0005 measured 37 MB
   after a day of orders; now it holds about 790 MB, more than half of it swapped out. Something
   grows across days.
3. **`fix_outbound` keeps every message of the day.** The gateway stores each outgoing FIX
   message so it can resend it; the simulator's session is reset at the roll, which clears
   it. At activity 2 that is several gigabytes by the evening, and it doubles with activity.

## Decision

1. **The server keeps only the images in use.** After every deploy, the agent removes every
   image no container is using (`docker image prune -a`), not just untagged ones. Rolling back
   still works: moving `live` to an older version pulls its images again from the registry.
   Done once by hand on 2026-11-15: 5.1 GB freed, disk from 44% to 27%.
2. **Simulator activity stays at 2 until the exchange's memory and `fix_outbound` are fixed.**
   CPU and cost have room; memory does not, and both problems grow with order volume. They
   are exchange work, investigated and decided separately, then activity is raised and
   measured again.
3. **The order book can get deeper now.** Patient limit traders who rest orders away from the
   touch add about one order per symbol every 10 to 20 seconds, around 1% of today's flow.

## Consequences

- **Disk grows only with data** (journals, kept 7 days; databases), not with releases.
- **A rollback downloads images** (about 1 GB, a minute or so), where before they might have
  still been on disk.
- **No busier simulator for now.** The limit is the exchange's memory, not CPU or money, and
  fixing it is the next step on the way to scaling up.
- **The measurement is repeatable:** the same SSM checks, CloudWatch CPU and credits, and Cost
  Explorer by record type (usage against credits).
