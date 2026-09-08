## A brand-new sales order becomes read-only minutes after it is saved, because the write-back stamps the column the lock reads [high]

**NOT FIXED IN THIS PR. It is a blocker on the go-live lift, and the choice of
fix is the owner's.** Written down now because the very next operational step —
lifting `scm.sales.orders` out of the write freeze — is what makes it reachable,
and the failure it produces is the exact opposite of the ruling that lift
exists to honour.

**Symptom. It happened today, to a real order** — the freeze is still on, so the
order was made by somebody who bypasses it, but every step of the mechanism ran.
A salesperson creates a new sales order. It saves.
Minutes later the AutoCount write-back pushes it into the account book, and from
that moment the order they just created shows the orange *"View only — carried
over from AutoCount"* banner with Edit greyed out. Owner's ruling 2026-09-08 was
「只开新单，旧单暂时不能改」 — open the new ones. This closes the new ones too,
shortly after they are made.

**Root cause (traced).** The migrated-SO lock's whole predicate is
`scm.mfg_sales_orders.linked_ac_docno IS NOT NULL`
(`backend/src/scm/lib/so-is-migrated.ts:28`, fed to `migratedSoIsLocked`). The
runbook and the middleware header both describe that column as "the origin
AutoCount document number, written by `import-ac-outstanding-so.mjs`, and NULL
for every order the ERP created itself".

**The second half of that sentence is false.** On a successful write-back the
outbox stamps the same column on the ERP's own document:

```
backend/src/scm/lib/autocount-outbox.ts:1902
    if (payload.writeback && result.docNo) {
      await sb.from(payload.writeback.table)
        .update({ linked_ac_docno: result.docNo })
```

`backend/src/routes/assr.ts:1326` says it in words — *"Migrated/写回 orders keep
their AutoCount number in `linked_ac_docno`"* — and
`backend/src/scm/lib/autocount-drain.test.ts:58` asserts it
(`expect(...mfg_sales_orders[0].linked_ac_docno).toBe('SO-000123')` on a row
that starts NULL). So the column answers "this document exists in AutoCount",
which is TWO populations: carried across by the cutover, and pushed there by us.

**Observed, not only reasoned.** Actions -> *Sales orders open for NEW — status
(read-only)*, run `34193634352`, read 2026-09-08 at 14:12 MYT:

```
scm.migrated_so_lock = "1"                     (updated 09:42:14 MYT)
NEW orders saved in the last 24h (company 1): 0 — of 0 ERP-created orders in all
MIGRATED orders touched by the SYSTEM in the last 24h: 638
MIGRATED orders touched by a PERSON  in the last 24h: 1
  HC-SO-2609-001  CREATE  by Lim  via web  08/09/2026, 14:06:51 MYT
```

`HC-SO-2609-001` carries the ERP's own `HC-SO-YYMM-NNN` numbering, not the
cutover's `HC-SO-0129xx`; a person CREATEd it six minutes before the read; and
it appears in the query filtered on `linked_ac_docno IS NOT NULL` while the
count of `linked_ac_docno IS NULL` is **0**. An ERP-created order is already
sitting in the "migrated" population today.

**And the write-back is what put it there — measured, not inferred.** Actions ->
*AutoCount outbox health (read-only)*, run `34194179668`, read 2026-09-08 at
14:20 MYT:

```
WRITE-BACK SWITCH scm.autocount_writeback = "1" -> ON for company 1
  - create_so  SENT 1 (of 1: failed 0, skipped 0, pending 0) last 2026-09-08T06:11
```

`06:11Z` is **14:11 MYT** — four minutes after Lim created the order and one
minute before the read that found it in the migrated population. The switch is
on, the send happened, and `autocount-outbox.ts:1902` is the line that stamps
the column on success. The whole chain is observed.

**Two things it breaks, not one.**

1. **The lock.** Any new order goes view-only once it reaches the book.
2. **The verification the go-live depends on.**
   `backend/scripts/check-so-open-for-new.mjs` counts new orders as
   `linked_ac_docno IS NULL`, so a successful write-back deletes the evidence
   that the lift worked — and the same order then re-appears as the "touched by
   a PERSON" alarm, which is what happened in the run above.

**Options (the owner picks).**

| | What it is | Cost / risk |
|---|---|---|
| **A. Lock on the CUTOVER population, not on the column** | Resolve "migrated" as "this document was inserted by the 2026-08 import" — e.g. `created_at < the cutover cut`, or the absence of a `scm.autocount_outbox` row that CREATED it. | No migrated row is touched (his hard rule holds). Needs one query to prove the two populations separate cleanly before it ships. |
| **B. Lift the lock at the same moment as the freeze** | `scm.migrated_so_lock = 'off'` in the same minute as step 1, so the predicate stops mattering. | Zero build. But it opens every migrated order at once, which is the thing he ruled shut, and it only becomes safe once this PR's sync guard is deployed. |
| **C. Do nothing and tell the floor** | Staff raise a ticket for any order they cannot edit. | Free, and wrong: it converts a system fault into a queue for IT on day one of go-live. |

**Recommendation: A**, with **B** as the stopgap if the go-live cannot wait for
it. A is the root fix — the lock should name the population the owner ruled on,
which is the documents that came FROM AutoCount, not the documents that have
BEEN to AutoCount. B is a stopgap and must be called one.

**Ref.** Found on fix/sync-human-edit-guard, 2026-09-08. Not fixed here.
