# Contract Decisions

Binding conventions for every service, in both languages. These are the things that are
expensive to change later because they leak into schemas, wire formats and arithmetic
everywhere. Change them by writing an ADR in `docs/adr/`, not by editing a service.

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


---

## 5. Venue

Every order, execution, fill, tick and ledger reference carries a `venue` field. In v1 it is
always `"ALPHA"`.

This costs nothing now and is what makes adding Exchange Beta a data change rather than a
migration across nine tables.

---

## 6. Market data sequencing

Every market data message carries `feed_seq`: a monotonically increasing `uint64`, scoped per
venue, starting at 1.

- It **never resets** while the venue is up, and never skips.
- A subscriber that observes a gap has lost data and must recover via snapshot + replay. It must
  not silently continue.
- `feed_seq` is assigned by the md-publisher, not the matching engine. The engine's own
  `arrival_seq` is an internal ordering concern and is not published.

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

---

## 9. Codegen

`contracts/proto/` is the source of truth. Generated code is **never committed** — it lands in
`gen/` (gitignored) and is produced by `buf generate`.

- Rust → `prost` + `tonic`
- TypeScript → `@bufbuild/protobuf`

A service must not hand-write a struct that mirrors a proto message. If the wire format and the
in-memory type need to differ (the matching engine's hot-path types will), convert explicitly at
the boundary and keep the conversion in one file.

`contracts/fix/fix44-subset.xml` is the source of truth for FIX. The Rust acceptor and the
TypeScript initiator are independent implementations that share only this dictionary — that
independence is the point, so neither may import the other's parsing code.
