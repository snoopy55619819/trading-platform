# fix-core — Milestone 2

**FIX 4.4 codec and session state machine.** A library, not a server. It has never heard
of an order book.

Status: **done** · 42 tests (`cargo test -p fix-core`)

## Inputs / outputs

| | |
|---|---|
| **In** | A byte stream (from TCP), and outbound messages to encode |
| **Out** | Parsed, validated messages; encoded bytes; session-level actions the caller must perform (send heartbeat, request resend, disconnect) |
| **Owns** | Session state: sequence numbers in and out, heartbeat timers, the outbound store for resends |
| **Source of truth** | `exchange-alpha/spec/fix44.xml` — 11 messages, 51 fields |

## Checklist

### 1. Framing
- [x] Split a byte stream into messages — a message ends after the `10=xxx|` trailer
- [x] Parse `tag=value` pairs delimited by SOH (`0x01`)
- [x] `BodyLength(9)`: bytes after `9=nn|` up to and including the SOH before `10=`
- [x] `CheckSum(10)`: sum of all preceding bytes mod 256, zero-padded to 3 digits
- [x] Reject a message whose checksum or body length disagrees — do not attempt repair
- [x] Handle a partial message at the end of a read buffer (TCP will split them)

### 2. Field access and validation
- [x] Typed getters: `STRING`, `INT`, `QTY`, `PRICE`, `CHAR`, `BOOLEAN`, `UTCTIMESTAMP`
- [x] **`PRICE` must parse to integer cents without touching a float.** `"42.10"` → `4210`.
      This is the first place the no-floats rule meets the outside world.
- [x] Required-field checks per message type, from the dictionary
- [x] Unknown message type, unknown tag, missing required tag → session-level `Reject(3)`
      with the right `SessionRejectReason`

### 3. Session state machine
- [x] `Logon(A)` — agree `HeartBtInt`, honour `ResetSeqNumFlag`
- [x] `Heartbeat(0)` on the interval; echo `TestReqID` when answering a test request
- [x] `TestRequest(1)` when the peer has been quiet for interval + slack
- [x] Inbound `MsgSeqNum` must be exactly what you expect:
      - too high → gap → send `ResendRequest(2)`, queue what follows
      - too low → fatal, log out
- [x] `ResendRequest(2)` handling — replay from the outbound store, with `PossDupFlag=Y`
      and the original `OrigSendingTime`
- [x] `SequenceReset(4)` — gap fill (`GapFillFlag=Y`) vs administrative reset
- [x] `Logout(5)` — both graceful and as a response to a fatal error
- [x] Persist sequence numbers so a restart resumes rather than restarting the count

### 4. Encoding
- [x] Build a message from typed fields, in the dictionary's field order
- [x] Compute `BodyLength` and `CheckSum` last
- [x] Store every outbound message for potential resend

### 5. Tests
- [x] Round-trip: encode → decode → identical fields
- [x] Checksum and body length against known-good hand-built messages
- [x] `"42.10"` → `4210` and back, and a table of awkward values (`"0.01"`, `"1000.00"`)
- [x] Gap: feed seq 1,2,4 and assert a `ResendRequest` for 3
- [x] Truncated and split messages across buffer boundaries

## Done when

A **QuickFIX** client logs on, sends `NewOrderSingle`, and receives `ExecutionReport`s.
Kill the connection mid-session and the `ResendRequest` recovers the gap. Interoperating
with a third-party implementation is the test that matters — two of our own agreeing
proves much less.

## Design

`Session` is a pure state machine: it is handed a message and the current time and returns
actions (send these bytes, deliver this message, disconnect). It never touches a socket or a
clock, so every timeout and sequence rule is tested in microseconds, and the same code serves
an acceptor and an initiator.

## Decisions

- **Any inbound traffic answers a TestRequest.** The spec asks for a Heartbeat echoing the
  `TestReqID`; we accept any message as proof of life, which is what the check is for.
- **During a gap, later messages are dropped, not queued.** We ask for everything from the
  missing number onward (`EndSeqNo=0`), so they come back in the resend anyway. Simpler, and
  nothing can be processed out of order.
- **On resend, session messages are gap-filled, not replayed.** Logon, Heartbeat,
  TestRequest, ResendRequest, Reject and Logout are covered by `SequenceReset` with
  `GapFillFlag=Y`; only application messages go again, with `PossDupFlag=Y` and their
  original `SendingTime` as `OrigSendingTime`.
- **Garbled frames are discarded silently** (bad `CheckSum` or `BodyLength`), without
  consuming a sequence number, as FIX requires. The counterparty sees the gap and resends.
- **Duplicate tags are rejected with `SessionRejectReason=5`.** The FIX code for it (13) is not
  in our dictionary's enumeration, and using it would make QuickFIX reject our Reject.

## Not done yet

- `SendingTime` accuracy (`SessionRejectReason=10`) is not checked.
- The outbound store grows for the life of a session; nothing trims it.
