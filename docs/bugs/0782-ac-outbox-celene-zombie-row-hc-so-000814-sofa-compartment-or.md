## AC outbox — CELENE zombie row + HC-SO-000814 sofa compartment order [low]

Two independent, doc-scoped repairs on the AutoCount write-back backlog.

**Symptom (CELENE).** The outbox carried a `skipped/ItemCodeError` row for
document `044f73de-c197-4e0d-a3f3-27fa0ab77724`. The UI showed it on Not
Accepted.

**Root cause (CELENE, traced).** `probe-doc-writeback` dispatched with that
UUID as `doc_no` and company 1 returned "NO SUCH DOCUMENT in this company." —
so neither `scm.mfg_sales_orders.doc_no` nor `scm.purchase_orders.po_number`
carries that value. The outbox row references a document that was deleted
from the ERP. Nothing sends and nothing ever will.

**Fix (CELENE).** `backend/scripts/repair-ac-outbox-clear-celene-zombie.mjs`
sets `archived_at = now()` on every outbox row for that `doc_no` under
company 1. It refuses if the document is found in either doc table (safe:
never archives a row that is still work). Dispatched via workflow, DRY-RUN by
default, `CONFIRM=ARCHIVE-CELENE-ZOMBIE`.

**Symptom (HC-SO-000814).** Composer refused with `SofaCollapseError`:
composed Desc2 decodes to `[L(LHF), 1NA, 2A(RHF)]` but the ERP holds
`[L(LHF), 2A(RHF), 1NA]`. Round-trip refused, doc stays skipped.

**Root cause (HC-SO-000814, traced).** The canonical AC line order is
`(created_at, id)` — `backend/src/scm/lib/ac-line-order.ts`, owner's rule
2026-09-02. `sofa-refusals` reports the ERP-held order for this sofa as
`[L, 2A(RHF), 1NA]`, matching the composer's refusal message. Owner ruling
2026-09-10: use the AC-decoded order `[L, 1NA, 2A(RHF)]`. So the ERP order
must be reshuffled to put `1NA` before `2A(RHF)`.

**Fix (HC-SO-000814).**
`backend/scripts/repair-so-000814-sofa-order.mjs` swaps `created_at` between
the two sofa compartment rows (`SOFA 5526 1NA` and `SOFA 5526 2A(RHF)`) on
this one document. The swap is its own undo. Refuses if either row is not
found exactly once. Dispatched via workflow, DRY-RUN by default,
`CONFIRM=SWAP-SOFA-000814`.

Both fixes cover ONE named document each and touch nothing else.

**Ref.** `fix/ac-backlog-celene-and-sofa-000814`, 2026-09-10.
