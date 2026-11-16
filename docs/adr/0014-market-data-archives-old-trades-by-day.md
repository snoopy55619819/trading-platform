# ADR 0014: market-data keeps a few days of trades, and archives older days to S3

**Status:** accepted, 2026-11-16. Stage 3 of `docs/SCALE-PLAN.md` (ADR 0012). Replaces the
backlog's "Tick retention without losing data".

## Context

market-data stores every trade the venue prints in `ticks`, forever. Measured on the server,
a trade costs 241 bytes with its indexes: 17 MB a day at today's activity, but about 1 GB a
day at 500 transactions a second and 2.1 GB at 1,000. With the exchange's journal now
compressed nightly (stage 3, #73), trades are what would fill the 30 GB disk: in about two
weeks at 500 a second, in about four days at 1,000.

What reads `ticks`:

- **Candles** (`GET /history`, the chart, `pnpm realism`) read `bars`, which the rollup builds
  from new trades as they arrive. Once a minute's bar exists, its trades are never read again.
- **Time and sales** (`GET /trades`) reads the latest 200 trades of a symbol.
- Nothing else. Old trades are kept only so they are not lost.

And `ticks` is not the only copy: every trade can be rebuilt from the exchange's journal,
which S3 keeps for a year.

## Options

1. **Archive by day:** keep the last few days in Postgres; write each finished day to a
   compressed file; the server sends the files to S3, as it does the journal.
2. **A columnar store** (ClickHouse): compresses trades about ten times and keeps them
   queryable, but it is another database to run on a 2 GB server, and nothing queries old
   trades today.
3. **A bigger disk:** EBS is about $0.08 per GB a month. It only moves the date the disk
   fills: 100 GB more buys about 45 days at 1,000 a second.

## Decision

Option 1, and how:

- **`ticks` is partitioned by UTC day** (one Postgres table per day under `ticks`). Removing a
  day is `DROP TABLE` on its partition: instant, and the disk space goes back to the system.
  Deleting millions of rows a day instead would write gigabytes of WAL and leave the space to
  autovacuum. The partition key `ts` joins the primary key and the duplicate check
  (`ticks_once`); `ts` is computed from `ts_ns`, so a repeated trade is still caught.
- **market-data looks after its own days,** once at start and then hourly:
  1. It creates the partitions for today and the next three days, so a trade always has
     somewhere to go.
  2. It writes each finished day (from 00:30 UTC the day after, so late trades are in) to
     `ticks-<date>.csv.gz` in its archive folder, written under a temporary name and renamed
     when complete, and records it in `market_data.archived_days` with its row count.
  3. It drops a day's partition once that day is more than `MD_KEEP_TRADE_DAYS` (1) days
     old and was written out at least 24 hours before, so the nightly backup has sent the
     file to S3 first. So Postgres holds today and yesterday.
- **Gzipped CSV, one file a day, every symbol:** readable by anything (`zcat`, Postgres
  `COPY`, DuckDB, ClickHouse), with a header. Columns are exactly the table's, so a day loads
  back with one `COPY`. Parquet would be smaller and faster to query, but needs a library;
  this can change later without touching the database.
- **The server sends the files to S3,** in `hosting/backup.sh` at 22:30 UTC, under
  `market-data-trades/`, and deletes each local file once S3 has it. market-data needs no AWS
  access, as the gateway does not for its day files. S3 keeps them indefinitely (no bucket
  rule): this is the "without losing data" part.
- **Candles stay in Postgres forever.** A day of 1-minute bars for ten symbols is about 2 MB.

## Consequences

- **Postgres holds at most two days of trades:** at 1,000 a second, up to about 4.2 GB, then
  back to about 2.1 GB at each day's drop. The disk at its fullest (just before 21:00 UTC,
  with the journal's day uncompressed) is about 13.8 GB at 500 a second (46%) and about
  25.7 GB at 1,000 (84%): above the 80% alarm. Running at 1,000 a second for long needs a
  larger disk (20 GB more is about $1.60 a month), decided with the numbers when the live
  server gets there (stage 7).
- **Time and sales and the charts are unchanged.** A visitor never sees a difference.
- **A day archived but not yet in S3 lives on one disk** for up to a day. If the disk were
  lost in that time, the trades can be rebuilt from the exchange's journal in S3.
- **The rollup is unaffected:** it reads only trades newer than its watermark, and those are
  always in today's or yesterday's partition.
- **Old trades are no longer queryable in Postgres.** To look at one: download the day's file
  and `COPY` it into a scratch table (`broker/market-data/TODO.md` has the commands).
- **Measured locally on real trades:** a day of 334,576 trades is 6.8 MB written out, about
  20 bytes a trade against 241 in Postgres, and loads back with every column identical. At
  1,000 a second, S3 gains about 175 MB a day (about $1.50 a month after a year).
- The migration rewrites `ticks` once, keeping every row and its `tick_id` (the rollup's
  watermark depends on them): about 720,000 rows on the server today, a few seconds.
