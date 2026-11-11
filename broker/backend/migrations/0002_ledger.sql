-- The broker's books: a double-entry ledger.
--
-- Every movement of cash or shares is a journal entry made of lines, and every entry
-- balances: per asset, the debits equal the credits. Balances, positions and cash are never
-- stored; they are sums over journal lines (see the account_balances view).
--
-- The rules that keep the books true are enforced HERE, not in application code, so no code
-- path (a bug, a script, someone in psql) can write an unbalanced entry or rewrite history:
--
--   * a line debits or credits a positive amount, never both
--   * a line's asset must be its account's asset: shares cannot land in a cash account
--   * at commit, every entry has lines and balances per asset (a deferred constraint trigger,
--     so an entry is built line by line inside a transaction and checked once it is whole)
--   * journal entries and lines are append-only: a mistake is corrected by a new entry
--
-- One convention throughout: these are the BROKER's books. Money and shares the broker holds
-- for clients are owed to them, so client accounts are liabilities and credit-normal.

-- A client's brokerage account: who the books are kept for. Users, logins and sessions
-- arrive with the API at milestone 6.
CREATE TABLE broker.accounts (
    account_id  text PRIMARY KEY,                      -- ULID
    name        text        NOT NULL,
    currency    char(3)     NOT NULL DEFAULT 'USD',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broker.ledger_accounts (
    ledger_account_id  text PRIMARY KEY,               -- ULID
    -- The client the account belongs to. NULL for the broker's own (house) accounts.
    owner_id           text REFERENCES broker.accounts (account_id),
    account_type       text NOT NULL,
    -- 'CASH' (amounts in cents) or a ticker (amounts in shares). Never mixed.
    asset              text NOT NULL,
    -- Which side increases the balance. Fixed by the account type.
    normal_balance     text NOT NULL,

    CONSTRAINT ledger_accounts_type_valid CHECK (account_type IN (
        'CLIENT_CASH', 'CLIENT_SECURITIES_UNSETTLED', 'CLIENT_SECURITIES_SETTLED',
        'FEES_REVENUE', 'HOUSE_CASH', 'STREET_CONTRA')),
    CONSTRAINT ledger_accounts_owner_matches_type CHECK (
        (account_type LIKE 'CLIENT\_%') = (owner_id IS NOT NULL)),
    CONSTRAINT ledger_accounts_cash_types CHECK (
        account_type NOT IN ('CLIENT_CASH', 'FEES_REVENUE', 'HOUSE_CASH') OR asset = 'CASH'),
    CONSTRAINT ledger_accounts_share_types CHECK (
        account_type NOT LIKE 'CLIENT\_SECURITIES\_%' OR asset <> 'CASH'),
    --   debit-normal:  HOUSE_CASH (the broker's bank), STREET_CONTRA (owed to us by the market)
    --   credit-normal: what the broker owes clients, and its fee revenue
    CONSTRAINT ledger_accounts_normal_balance CHECK (normal_balance = CASE
        WHEN account_type IN ('HOUSE_CASH', 'STREET_CONTRA') THEN 'DEBIT' ELSE 'CREDIT' END),

    -- One account per owner, type and asset. House accounts have a NULL owner, so NULLs
    -- must compare equal here or there could be two FEES_REVENUE accounts.
    CONSTRAINT ledger_accounts_unique UNIQUE NULLS NOT DISTINCT (owner_id, account_type, asset),
    -- Target for journal_lines' composite foreign key.
    CONSTRAINT ledger_accounts_id_asset UNIQUE (ledger_account_id, asset)
);

CREATE TABLE broker.journal_entries (
    entry_id        text PRIMARY KEY,                  -- ULID
    created_at      timestamptz NOT NULL DEFAULT now(),
    description     text        NOT NULL,
    -- What caused the entry. Unique, which is what makes posting idempotent: the same fill,
    -- deposit or settlement can never be booked twice.
    reference_type  text        NOT NULL,
    reference_id    text        NOT NULL,

    CONSTRAINT journal_entries_reference_type_valid
        CHECK (reference_type IN ('FILL', 'DEPOSIT', 'SETTLEMENT')),
    CONSTRAINT journal_entries_reference_unique UNIQUE (reference_type, reference_id)
);

CREATE TABLE broker.journal_lines (
    line_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id           text   NOT NULL REFERENCES broker.journal_entries (entry_id),
    ledger_account_id  text   NOT NULL,
    asset              text   NOT NULL,
    debit              bigint NOT NULL DEFAULT 0,
    credit             bigint NOT NULL DEFAULT 0,

    CONSTRAINT journal_lines_one_side CHECK (
        debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0)),
    -- The line's asset must be the account's asset. A foreign key rather than a trigger, so
    -- it is checked the same way every other reference in the schema is.
    CONSTRAINT journal_lines_account_asset FOREIGN KEY (ledger_account_id, asset)
        REFERENCES broker.ledger_accounts (ledger_account_id, asset)
);

CREATE INDEX journal_lines_entry ON broker.journal_lines (entry_id);
CREATE INDEX journal_lines_account ON broker.journal_lines (ledger_account_id);

-- Balance check, run at COMMIT for every entry that gained lines (and every new entry,
-- so an entry with no lines at all is caught too).
CREATE FUNCTION broker.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    bad record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM broker.journal_lines WHERE entry_id = NEW.entry_id) THEN
        RAISE EXCEPTION 'journal entry % has no lines', NEW.entry_id
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT asset, sum(debit) AS debits, sum(credit) AS credits INTO bad
    FROM broker.journal_lines
    WHERE entry_id = NEW.entry_id
    GROUP BY asset
    HAVING sum(debit) <> sum(credit)
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'journal entry % does not balance in %: debits %, credits %',
            NEW.entry_id, bad.asset, bad.debits, bad.credits
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
    AFTER INSERT ON broker.journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION broker.check_entry_balanced();

CREATE CONSTRAINT TRIGGER journal_entries_have_lines
    AFTER INSERT ON broker.journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION broker.check_entry_balanced();

-- History is never rewritten. TRUNCATE is blocked too: it bypasses row triggers.
CREATE FUNCTION broker.refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: post a correcting entry instead', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER journal_entries_append_only
    BEFORE UPDATE OR DELETE ON broker.journal_entries
    FOR EACH ROW EXECUTE FUNCTION broker.refuse_change();
CREATE TRIGGER journal_lines_append_only
    BEFORE UPDATE OR DELETE ON broker.journal_lines
    FOR EACH ROW EXECUTE FUNCTION broker.refuse_change();
CREATE TRIGGER journal_entries_no_truncate
    BEFORE TRUNCATE ON broker.journal_entries
    FOR EACH STATEMENT EXECUTE FUNCTION broker.refuse_change();
CREATE TRIGGER journal_lines_no_truncate
    BEFORE TRUNCATE ON broker.journal_lines
    FOR EACH STATEMENT EXECUTE FUNCTION broker.refuse_change();

-- Executions the ledger has booked: the trade record a fill entry is posted from. Kept
-- separately from the journal so reconciliation can tally positions a second, independent
-- way. At milestone 6 the OMS writes these from the exchange's execution reports.
CREATE TABLE broker.fills (
    fill_id          text PRIMARY KEY,
    venue            text        NOT NULL,
    exec_id          text        NOT NULL,
    order_id         text        NOT NULL,
    trade_id         text        NOT NULL,
    account_id       text        NOT NULL REFERENCES broker.accounts (account_id),
    symbol           text        NOT NULL REFERENCES broker.securities (ticker),
    side             text        NOT NULL,
    qty              bigint      NOT NULL,
    price_cents      bigint      NOT NULL,
    notional_cents   bigint      NOT NULL,
    -- Negative for a maker rebate.
    fee_cents        bigint      NOT NULL,
    currency         char(3)     NOT NULL,
    transact_ts_ns   bigint      NOT NULL,
    business_date    date        NOT NULL,
    -- When the shares stop being unsettled. The settle job books it on or after this date.
    -- v1 settles on the trade date; T+1 later changes how this is computed, not the schema.
    settlement_date  date        NOT NULL,
    booked_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fills_side_valid CHECK (side IN ('BUY', 'SELL')),
    CONSTRAINT fills_qty_positive CHECK (qty > 0),
    CONSTRAINT fills_price_positive CHECK (price_cents > 0),
    CONSTRAINT fills_notional_exact CHECK (notional_cents = qty * price_cents),
    CONSTRAINT fills_settles_after_trade CHECK (settlement_date >= business_date),
    -- An execution id is unique per venue: the same report arriving twice is one fill.
    CONSTRAINT fills_exec_unique UNIQUE (venue, exec_id)
);

CREATE INDEX fills_unsettled ON broker.fills (settlement_date);
CREATE INDEX fills_account_symbol ON broker.fills (account_id, symbol);

-- Every account's balance, in its normal direction: positive means the account holds what
-- its type says it holds. Derived on every read; there is nothing to keep in sync.
CREATE VIEW broker.account_balances AS
SELECT a.ledger_account_id,
       a.owner_id,
       a.account_type,
       a.asset,
       CASE a.normal_balance
           WHEN 'DEBIT'  THEN coalesce(sum(l.debit - l.credit), 0)
           ELSE               coalesce(sum(l.credit - l.debit), 0)
       END::bigint AS balance
FROM broker.ledger_accounts a
LEFT JOIN broker.journal_lines l ON l.ledger_account_id = a.ledger_account_id
GROUP BY a.ledger_account_id;

CREATE TABLE broker.reconciliation_runs (
    run_id         text PRIMARY KEY,                   -- ULID
    run_ts         timestamptz NOT NULL DEFAULT now(),
    checks_passed  boolean     NOT NULL,
    discrepancies  jsonb       NOT NULL
);
