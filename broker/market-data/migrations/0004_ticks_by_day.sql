-- Trades by UTC day (ADR 0014): `ticks` becomes a table partitioned on `ts`, one partition a
-- day, so a day that has been archived is removed with DROP TABLE instead of millions of
-- DELETEs. Every row is kept, with its tick_id: the rollup's watermark is a tick_id.
--
-- Partitions are named ticks_YYYYMMDD. This creates one for every day that has trades, up to
-- three days ahead; market-data creates the rest as days go by (src/store/archive.ts).

-- Move the old table out of the way, with everything that would clash by name.
ALTER TABLE market_data.ticks RENAME TO ticks_before_0004;
ALTER TABLE market_data.ticks_before_0004 RENAME CONSTRAINT ticks_once TO ticks_before_0004_once;
ALTER INDEX market_data.ticks_pkey RENAME TO ticks_before_0004_pkey;
ALTER INDEX market_data.ticks_symbol_ts RENAME TO ticks_before_0004_symbol_ts;
ALTER SEQUENCE market_data.ticks_tick_id_seq RENAME TO ticks_before_0004_tick_id_seq;

CREATE TABLE market_data.ticks (
    tick_id     bigint GENERATED ALWAYS AS IDENTITY,
    venue       text        NOT NULL,
    symbol      text        NOT NULL,
    -- When the venue sequenced it (the feed's ts_ns). Also which day's partition it is in.
    ts          timestamptz NOT NULL,
    ts_ns       bigint      NOT NULL,
    event_type  text        NOT NULL DEFAULT 'TRADE',
    price_cents bigint      NOT NULL,
    size        bigint      NOT NULL,
    -- Which side took liquidity: BUY or SELL.
    aggressor   text        NOT NULL,
    feed_seq    bigint      NOT NULL,
    symbol_seq  bigint      NOT NULL,
    trade_id    text        NOT NULL,

    CONSTRAINT ticks_event_type_valid CHECK (event_type = 'TRADE'),
    CONSTRAINT ticks_positive CHECK (price_cents > 0 AND size > 0),
    CONSTRAINT ticks_aggressor_valid CHECK (aggressor IN ('BUY', 'SELL')),
    -- A partitioned table's keys must include the partition key. ts is computed from ts_ns
    -- (store/ticks.ts), so adding it changes nothing about what counts as the same trade.
    PRIMARY KEY (tick_id, ts),
    -- A message delivered twice is stored once (see 0001_ticks_and_bars.sql).
    CONSTRAINT ticks_once UNIQUE (venue, feed_seq, ts_ns, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX ticks_symbol_ts ON market_data.ticks (symbol, ts);

DO $$
DECLARE
    first date := coalesce(
        (SELECT (min(ts) AT TIME ZONE 'UTC')::date FROM market_data.ticks_before_0004),
        (now() AT TIME ZONE 'UTC')::date);
    day date;
BEGIN
    FOR day IN SELECT generate_series(first, (now() AT TIME ZONE 'UTC')::date + 3, interval '1 day')::date LOOP
        EXECUTE format(
            'CREATE TABLE market_data.%I PARTITION OF market_data.ticks FOR VALUES FROM (%L) TO (%L)',
            'ticks_' || to_char(day, 'YYYYMMDD'),
            day::timestamp AT TIME ZONE 'UTC',
            (day + 1)::timestamp AT TIME ZONE 'UTC');
    END LOOP;
END $$;

INSERT INTO market_data.ticks
    (tick_id, venue, symbol, ts, ts_ns, event_type, price_cents, size, aggressor, feed_seq, symbol_seq, trade_id)
OVERRIDING SYSTEM VALUE
SELECT tick_id, venue, symbol, ts, ts_ns, event_type, price_cents, size, aggressor, feed_seq, symbol_seq, trade_id
FROM market_data.ticks_before_0004;

-- New trades carry on numbering after the old ones.
SELECT setval(
    pg_get_serial_sequence('market_data.ticks', 'tick_id'),
    coalesce((SELECT max(tick_id) FROM market_data.ticks_before_0004), 0) + 1,
    false);

DROP TABLE market_data.ticks_before_0004;

-- Each finished day written to a file (ADR 0014). A day's partition is dropped only once it
-- is here.
CREATE TABLE market_data.archived_days (
    day         date        PRIMARY KEY,
    file        text        NOT NULL,
    trades      bigint      NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now()
);
