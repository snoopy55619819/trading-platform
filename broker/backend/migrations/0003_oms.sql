-- Users, orders and the broker's FIX session with the exchange.
--
-- As with the ledger, the rules that must never break are enforced here:
--   * an order's terminal status (FILLED, CANCELED, REJECTED, EXPIRED) never changes
--   * an order never fills more than its quantity
--   * order_events is append-only: the orders row is the current state, the events are how
--     it got there
--   * a client order id is used once per account: the idempotency key for order entry

CREATE TABLE broker.users (
    user_id        text PRIMARY KEY,                    -- ULID
    email          text        NOT NULL,
    -- scrypt, as "salt:hash" in hex. Never the password.
    password_hash  text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_email_unique UNIQUE (email)
);

-- A brokerage account belongs to a user. Accounts opened before users existed (the
-- ledger's CLI, at milestone 5) have none.
ALTER TABLE broker.accounts ADD COLUMN user_id text REFERENCES broker.users (user_id);
CREATE INDEX accounts_user ON broker.accounts (user_id);

-- Per-account limits checked before an order is sent. A row is created with the account;
-- the defaults are deliberately modest.
CREATE TABLE broker.risk_limits (
    account_id             text PRIMARY KEY REFERENCES broker.accounts (account_id),
    -- The most a single order may be worth: $250,000.
    max_order_value_cents  bigint  NOT NULL DEFAULT 25000000,
    -- The most shares of one symbol the account may hold, counting working buys.
    max_position_qty       bigint  NOT NULL DEFAULT 100000,
    max_orders_per_min     integer NOT NULL DEFAULT 60,
    CONSTRAINT risk_limits_positive CHECK (
        max_order_value_cents > 0 AND max_position_qty > 0 AND max_orders_per_min > 0)
);

CREATE TABLE broker.orders (
    -- Ours, a ULID. Also the ClOrdID on the wire, so it is unique for the life of the FIX
    -- session, which the exchange requires.
    order_id           text PRIMARY KEY,
    -- The client's idempotency key: retrying a placement with it returns the same order.
    client_order_id    text        NOT NULL,
    account_id         text        NOT NULL REFERENCES broker.accounts (account_id),
    venue              text        NOT NULL,
    symbol             text        NOT NULL REFERENCES broker.securities (ticker),
    side               text        NOT NULL,
    order_type         text        NOT NULL,
    time_in_force      text        NOT NULL,
    price_cents        bigint,
    qty                bigint      NOT NULL,
    status             text        NOT NULL,
    filled_qty         bigint      NOT NULL DEFAULT 0,
    -- Exact running totals. The average price is derived from them, never stored.
    filled_notional_cents bigint   NOT NULL DEFAULT 0,
    fee_cents          bigint      NOT NULL DEFAULT 0,
    -- Cash held back from buying power while a buy works; zero once it is done.
    reserved_cents     bigint      NOT NULL DEFAULT 0,
    reject_reason      text,
    reject_text        text,
    -- The exchange's id for it (ALPHA-n), from its acknowledgement.
    exchange_order_id  text,
    -- The ClOrdID of the cancel request in flight, if any.
    cancel_cl_ord_id   text,
    -- When the NewOrderSingle was handed to the FIX session. NULL means not yet sent: an
    -- order committed just before a crash, which the next logon sends.
    sent_at            timestamptz,
    -- The same for the cancel request in flight: NULL with a cancel id means not yet sent.
    cancel_sent_at     timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT orders_client_order_id_unique UNIQUE (account_id, client_order_id),
    CONSTRAINT orders_cancel_id_unique UNIQUE (cancel_cl_ord_id),
    CONSTRAINT orders_side_valid CHECK (side IN ('BUY', 'SELL')),
    CONSTRAINT orders_type_valid CHECK (order_type IN ('LIMIT', 'MARKET')),
    CONSTRAINT orders_tif_valid CHECK (time_in_force IN ('DAY', 'GTC', 'IOC', 'FOK')),
    CONSTRAINT orders_status_valid CHECK (status IN (
        'PENDING_NEW', 'NEW', 'PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'CANCELED',
        'REJECTED', 'EXPIRED')),
    CONSTRAINT orders_price_matches_type CHECK (
        (order_type = 'LIMIT') = (price_cents IS NOT NULL)),
    CONSTRAINT orders_qty_positive CHECK (qty > 0),
    CONSTRAINT orders_never_overfilled CHECK (filled_qty >= 0 AND filled_qty <= qty),
    CONSTRAINT orders_reserved_not_negative CHECK (reserved_cents >= 0),
    CONSTRAINT orders_rejection_has_reason CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL))
);

CREATE INDEX orders_account_created ON broker.orders (account_id, created_at DESC);
CREATE INDEX orders_working ON broker.orders (account_id, symbol)
    WHERE status IN ('PENDING_NEW', 'NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL');
CREATE INDEX orders_exchange_id ON broker.orders (exchange_order_id);

-- Terminal is terminal. Enforced here so no code path can reopen a filled order.
CREATE FUNCTION broker.orders_terminal_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('FILLED', 'CANCELED', 'REJECTED', 'EXPIRED') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'order % is %, which is final; it cannot become %',
            OLD.order_id, OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER orders_terminal_is_final
    BEFORE UPDATE ON broker.orders
    FOR EACH ROW EXECUTE FUNCTION broker.orders_terminal_is_final();

-- Everything that ever happened to an order, in order.
CREATE TABLE broker.order_events (
    event_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    text        NOT NULL REFERENCES broker.orders (order_id),
    event_type  text        NOT NULL,
    -- The status after this event.
    status      text        NOT NULL,
    -- The exchange's execution id, for events caused by one. Unique, so an execution
    -- report delivered twice (a FIX resend) is recognised and applied once.
    exec_id     text,
    detail      jsonb       NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT order_events_exec_unique UNIQUE (exec_id)
);

CREATE INDEX order_events_order ON broker.order_events (order_id, event_id);

CREATE TRIGGER order_events_append_only
    BEFORE UPDATE OR DELETE ON broker.order_events
    FOR EACH ROW EXECUTE FUNCTION broker.refuse_change();
CREATE TRIGGER order_events_no_truncate
    BEFORE TRUNCATE ON broker.order_events
    FOR EACH STATEMENT EXECUTE FUNCTION broker.refuse_change();

-- The FIX session with the exchange: sequence numbers in both directions. One row per
-- session; the backend has exactly one. No row means "never logged on", and the first logon
-- asks the exchange to start both sides at 1.
CREATE TABLE broker.fix_session (
    sender_comp_id  text PRIMARY KEY,
    target_comp_id  text        NOT NULL,
    next_out_seq    integer     NOT NULL,
    next_in_seq     integer     NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Every application message sent, by sequence number, so a ResendRequest can be answered
-- with the real messages. Stored as the fields, not the bytes: a resend carries a new
-- SendingTime and PossDupFlag.
CREATE TABLE broker.fix_outbound (
    sender_comp_id  text        NOT NULL,
    seq             integer     NOT NULL,
    msg_type        text        NOT NULL,
    fields          jsonb       NOT NULL,
    sent_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sender_comp_id, seq)
);
