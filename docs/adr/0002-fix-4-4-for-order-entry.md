# ADR 0002: FIX 4.4 for order entry, not FIX 5.0

**Status:** accepted. Decided at milestone 0 and built in milestone 2; written down
2026-11-11, after the fact, because the choice was never recorded and is a natural
question. Explains `docs/DECISIONS.md` §9.
**Spec:** Alpha Exchange `spec/fix44.xml`, vendored by `broker/backend`.

## Context

The broker sends orders to Alpha Exchange over FIX, and the exchange sends execution
reports back. Both sides are written by hand (a Rust acceptor, a TypeScript initiator)
against one published dictionary, and conformance is tested against QuickFIX/Go, an
independent engine.

FIX 4.4 dates from 2003. FIX 5.0 SP2 followed in 2009, and FIX no longer ships numbered
versions at all: the current standard is "FIX Latest", updated continuously. So "why not
the newest?" deserves an answer.

## Options

1. **FIX 4.2.** Still widely used for equity order entry, but it predates the execution
   report model where every fill is reported as `ExecType=F` (Trade) with the order's
   status beside it (introduced in 4.3). We would have to carry the older, more ambiguous
   fill and partial-fill types.
2. **FIX 4.4.** The last version with the session and application layers in one
   specification. The version broker-to-exchange equity links most commonly speak, next
   to 4.2.
3. **FIX 5.0 SP2 over FIXT.1.1.** FIX 5 splits the protocol in two: a session layer
   (FIXT.1.1: logon, heartbeats, sequence numbers, resend) and an application layer, with
   the application version negotiated at logon and settable per message (`ApplVerID`). It
   adds instruments, order types and post-trade messages.

## Decision

Option 2, FIX 4.4.

- **It is what this kind of link uses.** Equity order entry between brokers and venues is
  dominated by 4.2 and 4.4; many venues still publish their order-entry specs on one of
  them. FIX 5 has its strongest adoption elsewhere: post-trade, some derivatives venues,
  and market data.
- **FIX 5's main change buys us nothing.** Splitting the session layer from the
  application layer lets one connection carry several application versions. This link is
  one broker and one exchange agreeing on one version, so FIXT would be machinery with no
  use: a second dictionary, version negotiation, and per-message version handling to
  write and test twice.
- **The messages we need are the same.** `Logon`, `Logout`, `Heartbeat`, `TestRequest`,
  `ResendRequest`, `SequenceReset`, `Reject`, `NewOrderSingle`, `OrderCancelRequest`,
  `OrderCancelReject` and `ExecutionReport` exist in 4.4 with the modern execution report
  model. What 5.0 adds (complex instruments, more order types, post-trade workflows) is
  outside this exchange's scope.
- **It is the best-supported version to test against.** QuickFIX/Go ships a standard 4.4
  data dictionary. Agreeing with an independent engine on the common version proves more
  than agreeing on a rarer one.

## Consequences

- The exchange publishes `spec/fix44.xml`, a subset of the FIX 4.4 dictionary; the broker
  vendors it. Moving to FIX 5 later would be a new published spec (and a FIXT session
  layer in `fix-core`), not an edit to this one.
- Speed-sensitive venues have largely moved order entry and market data to binary
  protocols (OUCH, ITCH, FIX's own Simple Binary Encoding) rather than to FIX 5. That is
  the direction this project already takes for market data: protobuf over WebSocket
  (`marketdata.proto`), not FIX. A binary order-entry protocol would be a separate,
  additional interface, not a replacement for this decision.
