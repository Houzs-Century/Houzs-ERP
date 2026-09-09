## A brand-new sales order becomes read-only minutes after it is saved, because the write-back stamps the column the lock reads [high]

**FIXED 2026-09-08 on `fix/so-open-for-new` — option B, MEASURED first. The
"Options" table below and everything above it is the record of the finding as
it stood; the decision and the evidence are in the two sections at the END of
this entry.** It was written down as NOT FIXED because the very next
operational step — lifting `scm.sales.orders` out of the write freeze — is what
makes it reachable, and the failure it produces is the exact opposite of the
ruling that lift exists to honour.

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

---

### MEASURED, then decided (2026-09-08)

The options below were written from reading. Neither signal had been measured,
so a read-only census was built and dispatched FIRST:
`backend/scripts/check-so-migrated-shape.mjs` + *SO migrated shape (read-only)*,
**run `34214516108`, production, company 1**:

```
SALES ORDERS (company 1): 2883
  linked_ac_docno IS NOT NULL — what the lock calls "migrated" today: 2883
  linked_ac_docno IS NULL     — what it calls "new" today:            0

SHAPE OF linked_ac_docno AGAINST doc_no
  equal          1   the ERP's own number went to the book -> WRITE-BACK
  prefixed    2882   doc_no is a prefix + the book number -> CUTOVER IMPORT
  neither        0   NEITHER — the shape rule cannot classify these
PREFIXES IN USE (1):  "HC-"  2882

THE TWO SIGNALS AGREE on every linked order: shape='equal' exactly where an
  outbox create_so row exists.
```

**The third bucket is EMPTY** — that was the question, and it is answered. And
the shape rule agrees with a second, independent signal (an
`scm.autocount_outbox` `create_so` row) on all 2,883 rows, with no
disagreement. Both pinned documents came back as required:

```
HC-SO-2609-001  book="HC-SO-2609-001"  shape=equal     erp_created_outbox=true
HC-SO-013361    book="SO-013361"       shape=prefixed  erp_created_outbox=false
```

`HC-SO-013361` is the right control precisely because it carries NINE `edit`
outbox rows, three of which AutoCount answered for: **having BEEN to AutoCount
is not the same as having come FROM it**, and the shape says so where the
column cannot.

### The three options, and why B shipped

| | What it is | Verdict |
|---|---|---|
| **A. A durable column** on `scm.mfg_sales_orders`, backfilled on the cutover rows — the `migrated_no_stock` pattern `0276_scm_migrated_documents.sql` uses for GRNs and DOs | **NOT AVAILABLE without the owner.** He has already ruled on exactly this, in his own words: adding a marker to a migrated row IS a change to the migrated data — 「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」 (`docs/migrated-so-lock.md` §2, repeated in §10). A backfill writes to 2,882 migrated rows. That is his call, not a session's, and the go-live could not wait on it |
| **B. The number's own shape** — no schema change, no row written | **SHIPPED.** Exact on the measured corpus (bucket three = 0), agrees with the independent signal 2,883/2,883, and it is not an accident: the import builds `docNo: "HC-" + acDoc` and `renumber-migrated-docs.mjs` exists to repair any migrated document that drifted off that shape back onto it |
| **C. A side table** keyed by document number, the way `scm.so_reconcile_verdict` already is | The durable form that does NOT re-open the owner's ruling. Not needed today — B is exact and free — but it is the upgrade path if the shape ever stops being reliable, and it needs no new ruling |

**What B costs, stated plainly.** A pair that fits NEITHER shape cannot be
produced by the cutover import, but `renumber-sales-orders.mjs` can give a
migrated order a new `doc_no`. So an unclassifiable pair **LOCKS** — the
fail-closed direction, consistent with every other decision in this subsystem
(`isMigrated === null` locks; a malformed switch value locks). Locking a
document nobody can classify is recoverable in a minute; opening one the owner
ruled shut is not. That bucket is empty today, and *SO migrated shape
(read-only)* is the check that will say when it stops being.

### The fix

`backend/src/scm/lib/so-is-migrated.ts` — the module that was already the one
home for this question — decides from the two document numbers instead of from
the presence of one. `soIsMigratedShape(docNo, acDocNo)` is pure and exported so
the tests are the specification.

**All five sites that asked the question move together**, which is the whole
reason the answer lives in one module: the middleware's read, the DETAIL
stamper, the LIST stamper, the line-PATCH pricing trust and the amendment
pricing trust. A predicate fixed on the endpoint and not on the list is the
"button does nothing" failure this repo keeps paying for, in reverse.

The two pricing sites are a bug of their own and have their own entry —
`docs/bugs/0713-an-order-the-erp-priced-itself-started-being-trusted-as-the.md`.

**Pinned by name** in `backend/tests/soIsMigratedShape.test.ts`:
`HC-SO-2609-001` answers FALSE, `HC-SO-013361` answers TRUE. **Proved RED on the
unfixed predicate** — reverting `soIsMigratedShape` to
`linked_ac_docno !== ''` fails 7 of its 24 tests; restored, 24 pass.

**Nothing was written to any document, and nothing needed to be.** This is a
predicate change: no migration, no backfill, no repair script. The reconcile was
run before and after as the control.

**Ref.** fix/so-open-for-new, 2026-09-08. Census: `#3241`, run `34214516108`.
