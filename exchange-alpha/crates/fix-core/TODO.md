# fix-core — Milestone 2

**FIX 4.4 codec and session state machine.** A library, not a server. It has never heard
of an order book.

Status: **not started** · depends on: nothing (can be built before or after M1)

## Inputs / outputs

| | |
|---|---|
| **In** | A byte stream (from TCP), and outbound messages to encode |
| **Out** | Parsed, validated messages; encoded bytes; session-level actions the caller must perform (send heartbeat, request resend, disconnect) |
| **Owns** | Session state: sequence numbers in and out, heartbeat timers, the outbound store for resends |
| **Source of truth** | `exchange-alpha/spec/fix44.xml` — 11 messages, 51 fields |

## Checklist

### 1. Framing
- [ ] Split a byte stream into messages — a message ends after the `10=xxx|` trailer
- [ ] Parse `tag=value` pairs delimited by SOH (`0x01`)
- [ ] `BodyLength(9)`: bytes after `9=nn|` up to and including the SOH before `10=`
- [ ] `CheckSum(10)`: sum of all preceding bytes mod 256, zero-padded to 3 digits
- [ ] Reject a message whose checksum or body length disagrees — do not attempt repair
- [ ] Handle a partial message at the end of a read buffer (TCP will split them)

### 2. Field access and validation
- [ ] Typed getters: `STRING`, `INT`, `QTY`, `PRICE`, `CHAR`, `BOOLEAN`, `UTCTIMESTAMP`
- [ ] **`PRICE` must parse to integer cents without touching a float.** `"42.10"` → `4210`.
      This is the first place the no-floats rule meets the outside world.
- [ ] Required-field checks per message type, from the dictionary
- [ ] Unknown message type, unknown tag, missing required tag → session-level `Reject(3)`
      with the right `SessionRejectReason`

### 3. Session state machine
- [ ] `Logon(A)` — agree `HeartBtInt`, honour `ResetSeqNumFlag`
- [ ] `Heartbeat(0)` on the interval; echo `TestReqID` when answering a test request
- [ ] `TestRequest(1)` when the peer has been quiet for interval + slack
- [ ] Inbound `MsgSeqNum` must be exactly what you expect:
      - too high → gap → send `ResendRequest(2)`, queue what follows
      - too low → fatal, log out
- [ ] `ResendRequest(2)` handling — replay from the outbound store, with `PossDupFlag=Y`
      and the original `OrigSendingTime`
- [ ] `SequenceReset(4)` — gap fill (`GapFillFlag=Y`) vs administrative reset
- [ ] `Logout(5)` — both graceful and as a response to a fatal error
- [ ] Persist sequence numbers so a restart resumes rather than restarting the count

### 4. Encoding
- [ ] Build a message from typed fields, in the dictionary's field order
- [ ] Compute `BodyLength` and `CheckSum` last
- [ ] Store every outbound message for potential resend

### 5. Tests
- [ ] Round-trip: encode → decode → identical fields
- [ ] Checksum and body length against known-good hand-built messages
- [ ] `"42.10"` → `4210` and back, and a table of awkward values (`"0.01"`, `"1000.00"`)
- [ ] Gap: feed seq 1,2,4 and assert a `ResendRequest` for 3
- [ ] Truncated and split messages across buffer boundaries

## Done when

A **QuickFIX** client logs on, sends `NewOrderSingle`, and receives `ExecutionReport`s.
Kill the connection mid-session and the `ResendRequest` recovers the gap. Interoperating
with a third-party implementation is the test that matters — two of our own agreeing
proves much less.
