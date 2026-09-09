## The ERP never took three AutoCount conversion transitions, and no writer existed for them [high]

**Symptom.** Go-live cutover, 2026-09-07. AutoCount says a purchase order has
been received, a sales order has been delivered, and a purchase order was raised
for a specific sales-order line. The ERP shows none of the three. Nobody had
reported it as a bug because nothing in the ERP is visibly wrong: the documents
look complete, they are simply behind the book — so a buyer re-orders goods that
are already in, and a sales order sits in the delivery board after the customer
has taken delivery.

`sync-ac-delta.mjs` gained a section 5 in PR #3047 that MEASURES the three
transitions and deliberately writes nothing. Measured against production on
read-only plan runs 34101082341 and 34101353639:

| transition | size |
|---|---|
| PO -> GR: ERP `received_qty` below AutoCount `TransferedQty` | 231 lines / 109 purchase orders (0 over-received) |
| SO -> DO: AutoCount delivered it, the ERP shows no delivery | 101 sales orders (91 full, 10 partial) |
| SO -> PO: the ERP purchase-order line carries no `so_item_id` | 47 lines |

**Root cause (traced).** Two separate causes, and the second is why the first
went unseen for the whole cutover.

1. **No writer.** Every AutoCount importer in `backend/scripts` is INSERT-ONLY.
   `topup-ac-po-lines.mjs` inserts MISSING LINES;
   `import-ac-outstanding-po.mjs` writes `received_qty` only at INSERT
   (`ON CONFLICT (doc_no) DO NOTHING` on the header, so a second run skips the
   document whole); every other file naming `received_qty` is a checker. **No
   path in the repository updated a line that already existed.** Same for
   `so_item_id` outside the header-stamp lane, and same for a delivery raised
   after the cutover cut.

2. **The delta could not see them.** `sync-ac-delta.mjs` keys its whole plan on
   the AutoCount document STAMPS. A conversion creates a CHILD document; what
   moves on the parent is the LINE's `TransferedQty`, and the parent HEADER's
   stamp need not move at all. Measured on the 2026-09-07 stamps cut
   (`since=2026-08-29`): of the 115 purchase orders a goods receipt was raised
   from, **110 do not appear in `stamps.PO`**; of the 166 sales orders a delivery
   was raised from, **60 do not appear in `stamps.SO`**. So every lane that
   iterates the edited-document list was blind to them by construction, and the
   conversion census only ever asked whether the SOURCE was in the ERP, never
   whether the ERP reflected the CHILD.

**Fix.** `sync-ac-delta.mjs` section 5 keeps its report and gains an APPLY path
for the three lanes, in the same script, the same workflow and behind the same
PLAN-by-default gate:

- `recv` copies `PODTL.TransferedQty` onto the matching ERP line, matched on
  `linked_ac_dtlkey` and refused where there is none. It never writes a value
  LOWER than the ERP holds and never one ABOVE the ordered quantity — both
  re-asserted inside the UPDATE, not only in the plan, so a goods receipt posted
  between the plan and the write cannot be undone by it. `GrQty` is not read
  anywhere: it is aggregated on (DocNo + ItemCode) and reading it per line is
  what once put 65 migrated lines into production with `received_qty > qty`.
- `do` creates the missing delivery documents, all-or-nothing per document, each
  stamped `migrated_no_stock = true` and posting NO inventory movement — the
  units already came out through the AutoCount balance snapshot (migration
  0276), so a second deduction double-counts them. The verification asserts
  that against `scm.inventory_movements` over every document created, not a
  sample.
- `dedi` writes `so_item_id` from `PODTL.FromSODtlKey`. `FromDocType` is NULL on
  all 10,792 SO->PO lines in the live book (see
  `docs/bugs/0661-qa-matrix-asserted-fromdoctype-on-the-so-po-edge-which-autoc.md`),
  so it is never read.

**The delivery-writing RULE was moved, not copied.** The matcher and writer now
live in `backend/scripts/lib/migrated-do-writer.mjs`, shared with
`create-migrated-documents.mjs`, which keeps owning the cutover cut. Only the
SOURCE differs: the committed fidelity DO snapshot is 307 documents behind the
live book, so lane `do` projects its rows out of `ac-reconcile-truth.json.gz`
instead. A second copy of an import rule is this repo's most expensive recurring
bug class, and this exact rule has already been repaired three times
(`docs/bugs/0016`, `0030`, `0043`, and `0617` for the money it dropped).

**The authorship test is the AUDIT TRAIL, never `version > 1`.** These lanes read
`scm.mfg_so_audit_log` and `scm.entity_audit_log` (`entity_type =
'PURCHASE_ORDER'`, migration 0139) for the fields they would write and nothing
else. `version` is an optimistic-locking token bumped by seven automated paths;
the probe in PR #3042 found 80 of 81 such "conflicts" were the automated
stock-allocation sweep and exactly one was a person.

`backend/tests/migratedDoWriter.test.mjs` pins the three guards the move had to
preserve. Proved RED on the unfixed tree: replacing the candidate-consuming
branch with `targets = [cands[0]]` — the exact shape of `docs/bugs/0043` — turns
2 of the 8 tests red; restoring it returns all 8 green.

**Ref.** feat/ac-conversion-apply-2026-09-07, 2026-09-07.
