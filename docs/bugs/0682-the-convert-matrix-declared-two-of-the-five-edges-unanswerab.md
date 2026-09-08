## The convert matrix declared two of the five edges unanswerable while the ERP recorded both [high]

**Symptom.** The owner asked for the transfer-from / transfer-to tally of the
whole transaction flow three times on 2026-09-07 and 2026-09-08 and never got a
complete one. `check-ac-convert-symmetry.mjs` measured presence in both
directions for four edges and, for the other two, printed a sentence instead of
a number:

```
    --- GR <- PO  (no document-grain book comparison possible - see above)
    --- PI <- GR  (no document-grain book comparison possible - see above)
        UNKNOWN by construction: the book names a GOODS RECEIPT number as the
        parent, and the ERP stores no AutoCount receipt number it could be
        matched against.
```

Two of the owner's five relationships therefore had **no forward count and no
backward count at all**, and the answer he was handed each time was a partial
one that read as complete because the missing rows carried an explanation.

**Root cause (traced).** The reasoning in that block is correct and the
conclusion drawn from it is not. `scm.grns.linked_ac_docno` really does hold the
receipt's PURCHASE ORDER number rather than the receipt's own — the checker's
own comment at what was line 904 says so, and `check-ac-erp-doc-links.mjs:104`
records the first run that matched the other way and reported all 216 receipts
as missing. From that true premise the block concluded the edge had no
document-grain identity on the child side.

It has one, on a different row. `backend/src/db/migrations-pg/0275_scm_po_ac_grn_refs.sql`
adds `scm.purchase_orders.linked_ac_grn_docnos text[]` and
`linked_ac_pinv_docnos text[]`, whose own `COMMENT ON COLUMN` states they hold
"AutoCount GR document numbers that received this PO before the cutover" and the
purchase invoices raised from them. A purchase-order row carrying
`linked_ac_docno = P` and `linked_ac_grn_docnos = {G1,G2}` is the ERP asserting
the edges `G1 <- P` and `G2 <- P` **in AutoCount's own numbering** — the exact
pair shape `bookDocEdges()` already produces for the other four edges.

The checker was reading that column eleven lines earlier, in section 4d, to
count how many receipt documents the ERP carries. It used it as a document
COUNT and never as an EDGE SET, so the fact that closes the gap was already on
screen in the same run that said the gap could not be closed.

This is CLAUDE.md's named trap "the check that answers a different question",
in its quietest form: the question asked was *does an ERP goods receipt carry an
AutoCount receipt number* (no, and permanently so), when the question that
decides the edge is *does the ERP anywhere record which AutoCount receipt came
off which purchase order* (yes, on the parent).

**Fix.** `backend/scripts/check-ac-convert-symmetry.mjs` section 5 now measures
both edges:

- **`GR <- PO` at true document grain.** ERP edge set built from
  `purchase_orders.linked_ac_grn_docnos` × `linked_ac_docno`, compared both ways
  against the book's 11,623 `(receipt, order)` pairs. The FORWARD denominator
  scopes on the PARENT only and says so — an ERP goods receipt has no AutoCount
  receipt number, so "did the ERP import this GR" is not a question that can be
  put, and requiring it would drop the whole edge instead of measuring it.
- **`PI <- GR` COMPOSED to `PI <- PO`.** The direct edge genuinely cannot be
  compared and that half of the old note stands. The relationship one hop wider
  can: the book's `PI <- GR` composed with its `GR <- PO` gives 11,543
  `(invoice, order)` pairs, and `linked_ac_pinv_docnos` is the ERP's assertion of
  the same pair. Labelled COMPOSED everywhere it is printed, with its limit
  stated on its own line — it proves the invoice hangs off the right ORDER,
  never off the right RECEIPT. Less than the owner asked for, more than
  "unknown", and both halves said out loud rather than one standing in for the
  other.

Two further gaps in the same file, closed in the same pass because the matrix is
the deliverable and a matrix with holes is the defect:

- **Section 6, IDENTITY.** The checker measured presence and symmetry and never
  asked whether the two ends name the same item — the class
  `docs/bugs/0672-bug-class-key-without-identity-a-link-written-on-the-key-alo.md`
  filed, which produced 15 real wrong links in production. Now one row per edge,
  with the unlinked (NULL) count printed beside the answer so a count taken only
  over rows that already carry a link can never read as clean.
- **The shared AutoCount line key, SETTLED.** 296 sales-order and 98
  purchase-order DtlKeys are carried by more than one ERP row, standing verdict
  "LIKELY all sofa decomposition, UNPROVEN". `probe-link-identity.mjs` cannot
  settle it — it counts how many shared keys carry rows naming DIFFERENT
  products, and a sofa decomposed into compartments produces exactly that, so
  its 295-of-296 is equally consistent with both readings. The checker holds the
  book snapshot, so each shared key is now resolved to its AutoCount `ItemCode`
  and tested with the repo's own sofa predicate (the `/\bSOFA\b/i` that
  `check-ac-erp-doc-links.mjs:145` already uses on this same question). A shared
  key whose book line is not a sofa is the finding; one whose book line is a sofa
  is the expected decomposition.

**Proved RED on the unfixed tree** by reading the previous run's own output:
runs `34148717552` and `34150405575` (2026-09-08 01:42 and 02:08 local) both
concluded `success` and both printed the two "no document-grain book comparison
possible" lines with no count beside them.

**Ref.** `cutover/txn-flow-tally`, 2026-09-08.
