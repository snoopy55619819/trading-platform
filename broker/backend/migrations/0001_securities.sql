-- The broker's security master: which instruments it will accept orders for.
--
-- Synced from the exchange's published listings (vendor/exchange-alpha/listings.json),
-- not authored here. The exchange decides what is listed; the broker decides what it is
-- willing to trade. Today those are the same set - that is a business decision, not a
-- schema one.

CREATE TABLE broker.securities (
    ticker                 text PRIMARY KEY,
    name                   text        NOT NULL,
    venue                  text        NOT NULL,
    -- Minimum price increment. A price is valid iff price_cents % tick_size_cents = 0.
    tick_size_cents        integer     NOT NULL,
    lot_size               integer     NOT NULL DEFAULT 1,
    currency               char(3)     NOT NULL DEFAULT 'USD',
    status                 text        NOT NULL DEFAULT 'ACTIVE',
    -- Anchors the price-band (fat-finger) check. Not a live price.
    reference_price_cents  bigint      NOT NULL,
    price_band_pct         integer     NOT NULL DEFAULT 20,
    updated_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT securities_status_valid  CHECK (status IN ('ACTIVE', 'HALTED', 'DELISTED')),
    CONSTRAINT securities_tick_positive CHECK (tick_size_cents > 0),
    CONSTRAINT securities_lot_positive  CHECK (lot_size > 0),
    CONSTRAINT securities_ref_positive  CHECK (reference_price_cents > 0),
    CONSTRAINT securities_band_valid    CHECK (price_band_pct > 0 AND price_band_pct <= 100),
    -- NULLIF so a zero tick yields NULL (not a violation) and lets securities_tick_positive
    -- report the real problem instead of "division by zero". Postgres does not guarantee
    -- the order CHECK constraints are evaluated in.
    CONSTRAINT securities_ref_on_tick   CHECK (reference_price_cents % NULLIF(tick_size_cents, 0) = 0)
);
