-- Each account's watchlist: the symbols it keeps an eye on, in the order it chose. Stored
-- with the account, not in the browser, so it follows the user to any device.

CREATE TABLE broker.watchlist (
    account_id  text        NOT NULL REFERENCES broker.accounts (account_id),
    symbol      text        NOT NULL REFERENCES broker.securities (ticker),
    -- Display order: lower first. Gaps are fine; only the order matters.
    position    integer     NOT NULL,
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, symbol)
);

CREATE INDEX watchlist_account_order ON broker.watchlist (account_id, position);

-- The order fills reached the ledger. Average cost depends on order (a sell before a buy
-- differs from a buy before a sell), and two fills can share a timestamp to the
-- millisecond, so cost basis orders by this. Existing rows are numbered as they stand.
ALTER TABLE broker.fills ADD COLUMN fill_seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX fills_account_seq ON broker.fills (account_id, fill_seq);
