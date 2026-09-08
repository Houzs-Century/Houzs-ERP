## A backfill's uniqueness guard counted the whole table not its own writes so a no-op run went red and stayed red for four weeks [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `backfill-po-ac-dtlkey.yml` has **one run in its entire history** and
it is red: run `31483323605`, 2026-08-11 18:41 Malaysia, dispatched with
`APPLY: 1`, ending

```
  KEY RECOVERED                 0
Error: REFUSED: 2 AutoCount keys would identify more than one line. Rolled back.
```

Nobody re-ran it for four weeks. Read as a status line it says "the purchase-order
line keys were never backfilled", which is what this session first concluded — and
it is wrong in both halves.

**Root cause (traced).** Two separate things, and the run log proves both.

*The guard measures the wrong population.* `backend/scripts/backfill-po-ac-dtlkey.mjs:113-121`
runs, inside the same transaction as its own `UPDATE` loop:

```js
const dup = await tx`SELECT COUNT(*)::int c FROM (
    SELECT i.linked_ac_dtlkey FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL
     GROUP BY i.linked_ac_dtlkey HAVING COUNT(*) > 1) d`;
if (dup[0].c) throw new Error(`REFUSED: ${dup[0].c} AutoCount keys would identify more than one line. Rolled back.`);
```

The `WHERE` names **every keyed line in company 1**, not the rows this run wrote.
The run's own `KEY RECOVERED 0` proves the plan was empty and the `UPDATE` loop
wrote nothing, so **the two duplicates it refused on already existed before it
started**. The guard's sentence — "keys *would* identify more than one line" —
describes a consequence of writes that did not happen. A run that changed nothing
was reported as a rolled-back failure.

*And the lane is redundant anyway.* `backfill-ac-line-keys.mjs` skips purchase
orders deliberately, saying `repair-migrated-po-lines.mjs` is the single writer.
That lane's run `33189216543` (2026-08-28, DRY-RUN) reads `migrated purchase
orders: 480; their lines: 1070` → **`missing linked_ac_dtlkey 0`**. Confirmed
independently from the other side: `ac-erp-reconcile` run `34189608519`
(2026-09-08 13:10) reports documents that "could NOT be line-matched" for SO (23),
GR (44), DO (25), IV (13) and PI (31) — **and no such line for PO at all.** PO is
the one document type whose keys are complete.

**Fix.** None to the script in this entry, deliberately — the finding is recorded
before the repair, and the correct repair is a decision: either scope the guard to
the rows the run touched (`WHERE i.id = ANY(written_ids)`), or retire the lane,
since the population it exists to fill is already 0. Writing either one without
that decision is how a redundant lane gets kept alive.

What this entry does change is the claim: `docs/autocount-link-map.md` §4.1 records
that the red run is a dead lane, not a broken live one, so the next reader does not
spend the morning this one did concluding that purchase-order keys are missing.

**The general shape, which is the reason this is `[medium]` and not `[low]`:** a
guard that counts a population wider than the action it guards will fire on
pre-existing state and blame the run in front of it. This is the same class as
`0682-the-goods-receipt-reshape-money-print-compared-two-different` and
`0691-the-not-linked-column-counted-765-lines-with-no-cause-attach` — a checker
whose denominator is not the thing it is checking. **And a lane that is
permanently red is indistinguishable from a lane that does not exist**: this one
sat unexamined for four weeks precisely because its own error message read like a
real refusal.

**Ref.** docs/ac-link-map, 2026-09-08.
