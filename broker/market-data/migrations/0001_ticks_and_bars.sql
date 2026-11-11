-- market-data's history: every trade the venue printed, and candles rolled up from them.
--
-- Public data only. Nothing here can identify a participant or an order: the feed it comes
-- from has no field for either.

-- One row per trade print.
CREATE TABLE market_data.ticks (
    tick_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue       text        NOT NULL,
    symbol      text        NOT NULL,
    -- When the venue sequenced it (the feed's ts_ns).
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
    -- A message delivered twice is stored once. feed_seq alone would do while the venue
    -- lives, and it survives a venue restart; ts_ns as well keeps a venue whose history was
    -- wiped (its numbering starts again at 1) from colliding with what came before.
    CONSTRAINT ticks_once UNIQUE (venue, feed_seq, ts_ns)
);

CREATE INDEX ticks_symbol_ts ON market_data.ticks (symbol, ts);

-- OHLCV candles. Only buckets with at least one trade have a row; a chart draws the rest
-- as empty.
CREATE TABLE market_data.bars (
    symbol       text        NOT NULL,
    interval     text        NOT NULL,
    bucket_ts    timestamptz NOT NULL,
    open_cents   bigint      NOT NULL,
    high_cents   bigint      NOT NULL,
    low_cents    bigint      NOT NULL,
    close_cents  bigint      NOT NULL,
    volume       bigint      NOT NULL,
    trade_count  integer     NOT NULL,

    CONSTRAINT bars_interval_valid CHECK (interval IN ('1m', '5m', '1h', '1d')),
    CONSTRAINT bars_ohlc_consistent CHECK (
        low_cents <= open_cents AND low_cents <= close_cents
        AND high_cents >= open_cents AND high_cents >= close_cents),
    -- One bar per symbol, interval and bucket: the rollup replaces it, never adds another.
    PRIMARY KEY (symbol, interval, bucket_ts)
);

-- How far the rollup has got: ticks with a higher id have not been rolled up yet.
CREATE TABLE market_data.rollup_state (
    id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
    last_tick_id       bigint      NOT NULL DEFAULT 0,
    updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO market_data.rollup_state DEFAULT VALUES;
