# ADR 0011: The gateway keeps a day's client order ids compactly, and uses mimalloc

**Status:** accepted, 2026-11-15. Built in the gateway (`orders.rs`, `main.rs`). The
finished-order side of ADR 0009's decision 2; ADR 0010 was the resend side.

## Context

ADR 0005 cut what the gateway keeps for a finished order to a small entry: enough to reject
a reused `ClOrdID` for the rest of the business day, and to answer a late cancel with how the
order ended. At `SIM_ACTIVITY=2` the simulator sends about 1.5 million orders a day, and every
entry stays until the 21:00 roll. Measured with a test program inserting 1.5 million of them
(peak memory as the operating system reports it):

| Layout | Peak for 1.5 million | For 3 million |
|---|---|---|
| As built: the `ClOrdID` as a `String` key, the entry as an enum | 212 MB | 422 MB |
| A 128-bit hash as the key, the same enum | 134 MB | 266 MB |
| The hash as two `u64`s, the entry packed into one `u64` | **102 MB** | **202 MB** |

The middle row saves less than its size suggests because a `u128` is aligned on 16 bytes, so
a slot pads to 32; two `u64`s and a packed value make it 24. Part of every peak is the hash
table doubling: for a moment it holds the old table and the new.

The gateway also ran on glibc's allocator, which kept memory the process had freed. After the
roll cleared the day's entries, the process still held the day's peak, and the idle part was
pushed to swap.

### What other venues do

Researched for this decision (public specs where stated):

- **Most large venues only reject a `ClOrdID` that matches a live order.** Cboe's US equities
  FIX spec calls the field day-unique but enforces it "only among currently live orders",
  "for reasons of economy"; CME iLink 3 lets an id be reused once its order has finished.
- **Nasdaq OUCH 5.0** gets day-wide protection with no memory at all: its order reference
  must strictly increase per port, so a duplicate is one integer comparison.
- No venue we found documents using a Bloom or cuckoo filter for this.

## Options

1. **Keep as is.** About 200 MB by evening at activity 2, double at 4.
2. **Check live orders only,** like Cboe and CME. No memory for finished orders at all, but it
   loosens Alpha's published rule (a finished order's id could be reused the same day) and a
   late cancel would get "unknown order" instead of how the order ended.
3. **Require increasing ids,** like OUCH. Day-wide and free, but every client must change how
   it numbers orders, and FIX does not ask for it.
4. **Keep every id, compactly:** a fixed 128-bit hash of the `ClOrdID` as two `u64`s, the entry
   packed into one `u64`, 24 bytes a slot.
5. **A Bloom filter.** Small, but it sometimes says "seen" for an id never used, which would
   reject a real order.
6. **A database** for finished ids. A disk read and compaction stalls on the order path.

And for the allocator: keep glibc's, or switch to **jemalloc** or **mimalloc**, both of which
return memory they no longer use to the system.

## Decision

Option 4, and mimalloc.

- **Same behaviour, less memory.** Every FIX answer stays as ADR 0005 has it: a duplicate is
  rejected all day, a late cancel says how the order ended. Memory at the day's peak roughly
  halves (212 MB to 102 MB at 1.5 million orders).
- **The hash is FNV-1a, 128 bits**, written out in about ten lines: fixed and published, so an
  id gives the same key on every run and version, which snapshots rely on. Its published test
  vectors are pinned in a test. Keys are per session, so a collision could only ever affect
  one client's own ids; at a billion orders a day the chance is about one in 10^21.
- **Snapshots store the keys** (32 hex digits) in new fields, `used_client_keys` and
  `finished_keys`. The old string fields are still read, and hashed on the way in, so
  snapshots already on the server load.
- **mimalloc, not jemalloc:** both return freed memory; mimalloc builds with only a C
  compiler, which the gateway's build image has, while jemalloc's build also needs `make`.
- Options 2 and 3 are the documented alternatives if memory is ever short again; Alpha keeps
  the stricter rule because FIX states it and, at this size, it is cheap.

## Consequences

- **The day's peak at activity 2 is about 100 MB for finished orders**, about 200 MB at
  activity 4, and with mimalloc the process gives it back after the roll instead of keeping
  it until it is swapped out.
- **A snapshot no longer contains the clients' `ClOrdID` strings**, only their keys. Nothing
  read them except the tracker itself; live orders still carry their ids in full.
- **Beyond about 10 million orders a day** this outgrows the server; options 2 and 3 are the
  ways out, both changes to Alpha's published rules.
- To be measured once released: the gateway's memory the evening before a roll, and after it.
