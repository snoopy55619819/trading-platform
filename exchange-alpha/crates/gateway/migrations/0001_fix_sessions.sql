-- FIX session state, owned by Alpha Exchange's gateway and nothing else.
--
-- Sequence numbers belong to a session (a CompID), not to a TCP connection: they must
-- survive disconnects and restarts, or a reconnecting client could never ask for the
-- messages it missed.

CREATE TABLE fix_sessions (
    comp_id       text PRIMARY KEY,
    -- The sequence number we expect on the next inbound message.
    next_in_seq   bigint      NOT NULL CHECK (next_in_seq >= 1),
    -- The sequence number our next outbound message will carry.
    next_out_seq  bigint      NOT NULL CHECK (next_out_seq >= 1),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Every message we sent, kept so a ResendRequest can be answered. Raw bytes exactly as they
-- went on the wire.
CREATE TABLE fix_outbound (
    comp_id  text   NOT NULL REFERENCES fix_sessions (comp_id) ON DELETE CASCADE,
    seq      bigint NOT NULL CHECK (seq >= 1),
    raw      bytea  NOT NULL,
    PRIMARY KEY (comp_id, seq)
);
