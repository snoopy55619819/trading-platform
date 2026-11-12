-- Headlines from the newswire (ADR 0006), stored as published. Public data, like ticks.
--
-- The newswire keeps only its last 1,000 headlines and forgets everything when it restarts,
-- so this is the broker's own record. A headline delivered twice (live, then again by a
-- catch-up) is stored once: its id is the newswire's ULID.

CREATE TABLE market_data.news (
    id          text        PRIMARY KEY,
    ts          timestamptz NOT NULL,
    symbol      text        NOT NULL,
    headline    text        NOT NULL,
    -- Kept as text: the newswire may add categories in a minor version (its spec says to
    -- accept ones we do not know).
    category    text        NOT NULL,
    tone        text        NOT NULL,
    severity    text        NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT news_tone_valid CHECK (tone IN ('POSITIVE', 'NEGATIVE', 'NEUTRAL')),
    CONSTRAINT news_severity_valid CHECK (severity IN ('MINOR', 'MAJOR'))
);

-- The latest for one symbol, and the latest across all of them.
CREATE INDEX news_symbol_ts ON market_data.news (symbol, ts DESC);
CREATE INDEX news_ts ON market_data.news (ts DESC);
