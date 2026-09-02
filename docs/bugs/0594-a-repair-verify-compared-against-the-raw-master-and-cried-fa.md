## A repair verify compared against the raw master and cried failure on a correct write [medium]

**Symptom.** `repair-blanked-venue` was applied to production (run 33424502242,
company 2). It wrote all five rows it planned to, then its own verification — a
fresh connection, comparing VALUES, exactly as release discipline asks — reported
that none of them held the right name:

```
APPLIED — 5 order(s) got their venue name back.
VERIFY (fresh connection, values not counts): 5 of 5 re-read; name matches the order's own venue id on 0
   UNEXPECTED 2990-SO-2606-008: venue="2990s PJ" should be "PJ Showroom"
   ... (all five)
VERIFY FAILED — investigate before re-running.
```

The `UPDATE` and the verify joined the same primary key on the same column, so
they cannot disagree — which is what made this worth stopping for rather than
re-running.

**Root cause (traced, with the tool that proved it).** A read-only probe over
`pg_trigger` (`backend/scripts/probe-venue-write-divergence.mjs`, run
33424857183) returned it on the first section:

```
1. TRIGGERS on scm.mfg_sales_orders: 1
   trg_mfg_sales_orders_canonicalize_venue -> mfg_sales_orders_canonicalize_venue()
   CREATE TRIGGER ... BEFORE INSERT OR UPDATE OF venue ON scm.mfg_sales_orders
```

Migration `0229_venue_canonicalize.sql` installs a BEFORE-write trigger that
folds known venue aliases, because the same physical showroom kept re-appearing
as both **"PJ Showroom"** and **"2990s PJ"** and three one-shot cleanups had each
drifted back. The canonical name is **"2990s PJ"**.

So the repair handed the database `venues.name` = "PJ Showroom", the trigger
folded it to "2990s PJ", and the verify compared the stored value against the RAW
master it had read a moment earlier. **The write was correct and the check was
wrong.**

**Why this direction is the dangerous one.** A verify that misses a bad write is
the failure everyone anticipates. A verify that fails a GOOD write is worse in
practice: it invites the next person to re-run a repair that already worked, or
to revert one, on the authority of a red line in a log. Release discipline in
CLAUDE.md asks a repair to "re-read on a fresh connection and assert the SHAPE" —
this one did all of that and still lied, because it asserted against the value it
SENT rather than the value the database would STORE.

**Fix.** The verify now compares against `scm.canonicalize_venue(ven.name)` —
what the trigger will actually store — and separately REPORTS any venue master
row whose own name is a non-canonical alias, since that is a picker still handing
out the old spelling. Folding those rows is `backfill-canonicalize-venue.mjs`,
which has its own dry run; mig 0229 is explicit that it performs no backfill, and
this repair does not either.

**The five orders are fine.** They hold "2990s PJ", which is the name
`2990-SO-2608-070`'s audit log shows it carrying before the blanking. The venue
repair achieved exactly what it set out to.

**The probe is kept**, not deleted with the answer: "the write and the read-back
disagree" recurs, and `pg_trigger` is the first place to look. It is read-only —
SELECTs, no DDL, no transaction.

**Lesson, general.** Before writing a verification, ask what the DATABASE does to
a value between the write and the read: triggers, defaults, generated columns,
domain coercions. Assert the stored form, not the submitted one.

**Ref.** diag/venue-write-divergence, 2026-09-01.
