## The GRN picker sorted by a UUID and cut at 500, hiding 168 of 356 outstanding PO lines [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner 2026-08-17: he could not convert `HC-PO-2608-001` to a goods
received note. Two screens of his own ERP contradicted each other about one
document. The purchase order detail showed 2 lines (`9028-1A(LHF)`,
`9028-2A(RHF)`), each `Ordered 1 / Received 0 / Balance 1`, `Submitted ·
awaiting supplier delivery`, receipt progress `0 / 2`. The picker at
`/scm/grns/from-po?poId=…` showed `0 OF 0 ROWS` and "No outstanding PO lines —
every line has been received (or there are no outstanding POs)."

**Root cause (traced, not guessed).** `GET /outstanding-po-items`
(`scm/routes/grns.ts`) read
`.order('purchase_order_id', { ascending: false }).limit(500)` and applied BOTH
of its filters AFTERWARDS in JavaScript. `purchase_order_id` is a **uuid**, so
that ordering is not "newest first" — it is arbitrary. The 500 was therefore an
arbitrary SAMPLE of the company's PO lines, spent mostly on lines that were
never candidates, and a brand-new purchase order was as likely to fall outside
it as any other.

Proved by querying production, not by reading the handler: a read-only probe
(`backend/scripts/why-po-not-receivable.mjs`, workflow *Why is a PO not
receivable (read-only)*, run 32028603860) evaluated each gate separately and
named the one that fired. For company HOUZS: **875 PO lines, 356 genuinely
outstanding, and the window let the picker see only 188 of those 356 — 168
outstanding lines were unreachable through the screen that exists to receive
them.** `HC-PO-2608-001` had **567 rows sorting ahead of it**, so both lines
fell outside the cut.

**Two theories the probe RULED OUT, both plausible from reading the code:**
- *The status.* The rendered "Submitted" is a label, not the column. The column
  really is `SUBMITTED`; the status gate passed.
- *The company stamp.* The scope added on 2026-08-10 fails closed, and the PO
  came from the SO-to-PO conversion, so a missing `company_id` would have looked
  exactly like this. It is not missing: header `company_id = 1`, both lines
  `company_id = 1`, and table-wide **0** `purchase_order_items` disagree with
  their header and **0** are NULL. The conversion stamps correctly.

**Fix.** The parent-status filter moves INTO the statement
(`.in('po.status', RECEIVABLE_PO_STATUSES)` through the `!inner` embed, which
bounds the read to open work) and `.limit(500)` becomes `paginateAll` with a
`(purchase_order_id, id)` total order, so nothing is dropped without an error.
Raising the number would not have fixed it — PostgREST caps a response at 1000
rows whatever `.limit()` says, which only moves the same silent truncation
further away. The handler's hand-written copy of the status pair is deleted in
favour of `RECEIVABLE_PO_STATUSES` (`grns.ts:191`), which it had been
duplicating. Only the remaining-qty test stays in JS: it compares two COLUMNS,
and PostgREST has no filter for that.

**The empty state was a second, independent bug and is fixed too.** "Every line
has been received" was asserted as fact from an absence of rows. The read is
company-scoped and **fails closed**, so a fail-closed scope rendered as a
cheerful all-done, and the operator acts on that by walking away from work that
is still outstanding. `GrnFromPo.tsx` already had honest wording for the ERROR
case two lines above and none for the empty one. Three states now read
differently — failed read, rows loaded but filtered out, nothing returned — and
only the middle one says anything about received work.
`grnFromPoEmptyState.test.tsx` pins all three; three of its five tests fail
against the old copy (the other two are the paired controls that stop the
negative assertions passing on a blank page).

**Ref.** PR #2365, 2026-08-17. Probe: PR #2364.
