# Domain Decisions

Binding conventions for every service, in both languages and across both companies. These
are the things that are expensive to change later because they leak into schemas, wire
formats and arithmetic everywhere.

`CLAUDE.md` carries the short list of what the rules *are*; this document carries the
detail and the reasoning. Change a rule by writing an ADR in `docs/adr/`, not by editing a
service.

---

## 1. Money, prices and quantities

**Never use floating point for money, prices, or quantities. Anywhere. For any reason.**

| Concept | Type | Unit | Example |
|---|---|---|---|
| Cash | `int64` | minor units (cents) | `15002` = $150.02 |
| Price | `int64` | minor units (cents) | `15002` = $150.02 per share |
| Quantity | `int64` | whole shares | `100` |
| Notional | `int64` | cents | `price_cents * qty` |
| Fee | `int64` | cents | rounded half-up at the point of calculation |

Field names carry their unit: `price_cents`, `qty`, `notional_cents`, `fee_cents`. A bare
`price` or `amount` is a bug.

### Tick size

The plan called for prices in "integer ticks". We express price directly in **cents**, and treat
tick size as a **validation rule** rather than a separate unit:

```
valid  ⟺  price_cents % tick_size_cents == 0
```

Same guarantees, no conversion layer between "ticks" and "cents" for every service to get wrong.
The order book keys on `price_cents` directly. `tick_size_cents` lives in refdata per symbol.

### Rounding

Only fees and averages ever need rounding. `avg_fill_price_cents` is
`total_notional_cents / total_qty` using integer division, and the exact
`total_notional_cents` is always carried alongside it so no precision is lost — never
reconstruct notional by multiplying the average back out.

### Currency

USD only in v1, but every monetary message carries an explicit `currency` field. Adding a second
currency should be data, not a migration.

---

## 2. Time

| Context | Representation |
|---|---|
| Engine, market data, journals | `int64` nanoseconds since Unix epoch, UTC |
| Postgres | `timestamptz`, always UTC |
| JSON / REST APIs | ISO-8601 with explicit offset (`2026-09-07T14:32:11.123Z`) |
| FIX | `UTCTimestamp`, millisecond precision (`YYYYMMDD-HH:MM:SS.sss`) |

No service stores or transmits local time. `business_date` is a separate `date` field and is
**not** derivable from a timestamp by any service other than the (future) clock — trading days
don't align to UTC midnight.

---

## 3. Identifiers

| ID | Assigned by | Format | Uniqueness |
|---|---|---|---|
| `client_order_id` (ClOrdID) | the client | ULID | Unique per FIX session per business date |
| `order_id` | the exchange | `{VENUE}-{monotonic}` | Per venue, forever |
| `exec_id` | the exchange | `{VENUE}-E{monotonic}` | Per venue, forever |
| `trade_id` | the exchange | `{VENUE}-T{monotonic}` | Per venue, forever |
| `account_id`, `entry_id`, … | the owning service | ULID | Global |

**ULID over UUIDv4** for service-assigned IDs: lexicographically sortable by creation time, which
makes them usable as index keys and makes log output readable. Exchange-assigned IDs are
monotonic integers because the engine must not spend hot-path time generating randomness, and
because gaps in the sequence are diagnostically useful.

`client_order_id` is the **idempotency key** for order entry. A duplicate must be rejected, never
executed twice.

---

## 4. Enums

Proto3 rules, applied everywhere including the SQL schema:

- `0` is always `*_UNSPECIFIED` and always invalid as input. A zero-valued enum arriving at a
  service boundary is a rejected message, never a defaulted one.
- Numeric values are **pinned forever**. Never renumber, never reuse a retired number.
- SQL stores the enum's **string name**, not its number, with a `CHECK` constraint. Readable in
  `psql`, and a schema-level guard against typos.

### Generated names differ per language

`buf` strips the enum's own name from its value names. The proto name is the contract; the
generated name is not:

| Proto | TypeScript | Rust (prost, from M3) |
|---|---|---|
| `SIDE_BUY` | `Side.BUY` | `Side::Buy` |
| `ORD_STATUS_PARTIALLY_FILLED` | `OrdStatus.PARTIALLY_FILLED` | `OrdStatus::PartiallyFilled` |
| `REJECT_REASON_UNKNOWN_SYMBOL` | `RejectReason.UNKNOWN_SYMBOL` | `RejectReason::UnknownSymbol` |

Always write the **proto** name in specs, ADRs, logs and SQL. `Side.SIDE_BUY` is `undefined`
in TypeScript, and it fails silently: `create()` will happily accept it and default the field
to zero.

This applies only to generated code — currently just `broker/market-data`, which decodes the
venue feed. The broker's own domain types are hand-written and use their names directly.


---

## 5. Venue

Every order, execution, fill, tick and ledger reference carries a `venue` field. In v1 it is
always `"ALPHA"`.

This costs nothing now and is what makes adding Exchange Beta a data change rather than a
migration across nine tables.

---

## 6. Market data sequencing

Every sequenced market data message carries two numbers, both `uint64`, both starting at 1,
both never resetting and never skipping:

| | Scope | Used for |
|---|---|---|
| `feed_seq` | the venue | ordering messages across symbols; heartbeats carry it |
| `symbol_seq` | one symbol | **gap detection**, since a subscriber only receives its symbols |

- Each `BookDelta` and `TradePrint` takes the next value of both. `Snapshot` and `Heartbeat`
  take neither; they carry the latest values already used.
- A subscriber that sees `symbol_seq` skip has lost data and must recover via a fresh
  snapshot (`ResyncRequest`). It must not silently continue.
- Both are assigned by the md-publisher, not the matching engine, and depend only on the
  journal, so a restart replays them back to where they were.

Why two numbers rather than one: [ADR 0001](adr/0001-per-symbol-feed-sequence.md).

---

## 7. The two planes

Contract-level consequence of the architecture: **an execution report and a public trade print
are different messages carrying different information**, even when they describe the same match.

| | Execution report (private) | Trade print (public) |
|---|---|---|
| Recipient | the order's owner only | every subscriber |
| Identifies the account | yes | **never** |
| Carries `client_order_id` | yes | **never** |
| Carries aggressor side | yes | yes |
| Delivered over | FIX / order plane | market data plane |

Leaking an account identifier or a `client_order_id` onto the market data plane is a correctness
bug, not a privacy nicety.

---

## 8. Ledger

- Every journal entry balances: `SUM(debit) = SUM(credit)`, **per entry, per asset**.
- Shares and cash are different assets and balance independently. `asset` is `'CASH'` or a
  ticker; share amounts are in shares, cash amounts in cents. They never appear in the same
  balancing group.
- Positions and cash balances are **derived** from `journal_lines`. No service stores a
  running total it increments.
- Settled and unsettled holdings are **separate accounts**, not a flag on one row — even though
  v1 settles instantly.
- The rules above are **enforced by Postgres**, not by application code: a deferred
  constraint trigger checks every entry's balance at commit, a composite foreign key keeps
  an account's asset and its lines' asset the same, and journal tables refuse `UPDATE`,
  `DELETE` and `TRUNCATE`. A mistake is corrected by a new entry.
- These are the **broker's** books: client cash and client securities are liabilities
  (credit-normal). Detail and the posting rules: `broker/backend/TODO.md`.

---

## 9. Specs and codegen

There is no repo-wide contracts directory. Each company owns what it publishes, and each
consumer vendors its own copy.

| Artifact | Owner | How others get it |
|---|---|---|
| `fix44.xml` | Alpha Exchange | `broker/backend` vendors a copy |
| `marketdata.proto` | Alpha Exchange | `broker/market-data` vendors a copy |
| `listings.json` | Alpha Exchange | both vendor a copy |

Every consumer runs its own `scripts/sync-spec.mjs`, which stamps the spec version and
file hashes into `vendor/exchange-alpha/SPEC_VERSION.json`. `spec:check` fails when the
copy falls behind. **A stale copy is integration work, not a repo defect** — read the diff,
decide what changes, then re-sync.

**Protobuf is for real wire formats only.** Types that never cross a process boundary are
plain TypeScript inside whichever service owns them (`broker/backend/src/domain/`). The
broker had four internal protos while api/oms/ledger were separate services; merging them
into one process removed the wire, so the protos went too.

Generated code is **never committed** — it lands in `gen/` (gitignored) and is produced by
`buf generate`. A service must not hand-write a struct mirroring a proto message; if the
wire format and the in-memory type need to differ (the matching engine's hot-path types
will), convert explicitly at the boundary and keep the conversion in one file.

**Rust generates no protobuf yet.** The matching engine (M1) and the FIX layer (M2) touch
none, and the first Rust consumer is `md-publisher` at M3. Wiring prost before then would
be build machinery with no caller.

The Rust FIX acceptor and the TypeScript FIX initiator are independent implementations
that share only the dictionary. Neither may import the other's parsing code — that
independence is the point, and it is why conformance is tested against QuickFIX rather
than against ourselves.
