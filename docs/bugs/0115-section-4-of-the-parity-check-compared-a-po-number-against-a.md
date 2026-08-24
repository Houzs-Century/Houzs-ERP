## Section 4 of the parity check compared a PO number against a GR number [medium]

**Symptom** — "the two disagree about which receipt: 291" of 449 purchase
orders, with every example printing the PO number on the ERP side:
`PO-009304: the ERP's GRN points at PO-009304; AutoCount says GR-004996,
GR-005018`. A 65% disagreement rate on document flow that was entirely fictional.

**Root cause (traced, not guessed)** — the query read `scm.grns.linked_ac_docno`
as if it held the receipt's AutoCount number. It holds the PURCHASE ORDER's:
`create-migrated-documents.mjs` inserts `g.po.linked_ac_docno` into that column,
which contradicts migration 0276's own `COMMENT ON COLUMN` ("The AutoCount GR
document this row mirrors"). Comparing a `PO-` string to a set of `GR-` strings
can only ever fail. Two further faults were in the same comparison: it used
string equality where one AutoCount receipt legitimately spans several POs
(1,250 of 4,939 do), and it never checked whether the reference data it depended
on had been populated at all.

**Fix** — section 4 now reads `scm.purchase_orders.linked_ac_grn_docnos` (what
`stamp-ac-grn-refs.mjs` writes), cross-checked against the number the migrated
GRN was minted with (`HC-<AC GR>`, or `HC-<AC GR>-<AC PO>` when the receipt
covers several POs), and compares by SET MEMBERSHIP. `migrated_no_stock` GRNs
count as received — they are real documents that carry no movement on purpose.
4a verifies the stamp before any conclusion is drawn and says so if it is empty;
4c extends the chain to purchase invoices; 4d separates "the document exists"
from "the document is linked". Corrected: 427 agree, 10 AutoCount-only,
12 ERP-only, **0 genuine receipt disagreements**.

**The class, for next time** — a column whose CONTENT contradicts its own
`COMMENT` is a trap with a documentation-shaped lid. The comment said GR, the
writer wrote PO, and a reader who trusted either one was wrong. When a check
depends on reference data being populated, verify the population FIRST — an
empty column reads exactly like a total disagreement.

**Ref** — 2026-08-11, PR #1914 (fix/parity-checkers).
