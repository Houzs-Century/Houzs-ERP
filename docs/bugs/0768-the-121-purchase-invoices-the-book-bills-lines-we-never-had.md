## The 121 purchase invoices the book bills lines we never had were counted as work [medium]

**Symptom.** The reconcile reports 121 purchase invoices under `a book line we do
not have`. The owner reads that column as work owed, and it is the last thing
standing between the purchasing lane and a clean tally.

**Root cause, traced one level up from where the first hypothesis put it.**
`docs/bugs/0767` records the refuted attempt: *the source RECEIPT is out of
scope* explained 17 of 189, not 121. The cause is the receipt's PARENTS. Only
OUTSTANDING purchase orders were migrated — the book holds 9,416 and 474 came
over — while **one AutoCount goods receipt serves many purchase orders**.
Measured on the committed cut: 124 of the 211 in-scope receipts carry lines
raised from an order we never imported, 837 such lines against 587 in scope, and
`GR-000201` alone carries 12 lines from TEN orders of which two are in scope. Our
purchase invoice is built from OUR receipt, so it can only carry the lines whose
order came in. The book bills the rest. **Not a line we lost — a line we never
had.**

**Why it needed a rule of its own rather than section 6's.** The existing
`UNMIGRATED_ONWARD` split keys on the DOCUMENT a book row was raised onward to.
This one keys on the SOURCE of an individual LINE, and one document mixes both —
`GR-000201` again. A rule stated at document grain answers the wrong question,
which is exactly why the first hypothesis measured 17.

**Fix.** `lib/ac-not-a-difference.mjs` section 7 — `UNMIGRATED_SOURCE` and
`splitUnmigratedSourceLine`, wired through `lib/ac-chain-shape.mjs` as a SECOND
pass over the rows the shape proof refused, so the two lanes cannot both claim a
document. Four gates, the last three measured per line:

1. the type DECLARES the decision (`UNMIGRATED_SOURCE[t]`, no type letter in the
   wiring);
2. the book NAMES a source for the line;
3. every candidate source is the declared type;
4. we hold NONE of them — coverage is READ off the ERP's own purchase-order
   rows, never off `SCOPE`, which states the population the migration was
   *defined* to carry rather than the one it did.

**And the verdict is per DOCUMENT, so it is all or nothing.** The reconcile
records this axis once per document and reclassifying moves the whole document.
A receipt whose eleven unpaired lines are migration gaps and whose twelfth is a
line we really lost must NOT leave the column — that is `docs/bugs/0668` with the
arrow reversed, and it cost 30 documents. So the gates run over EVERY unpaired
line and the first that fails names why the document stayed.

**`sourceOf` returns a LIST, and that is evidence rather than caution.** The book
does not name a purchase order on a purchase-invoice line at all: `FromDocType`
is `GR` on every one, so the order is a hop further up, found by matching the
invoice line's item against the receipt's lines. Measured over the 1,349 lines of
the 189 in-scope invoices: **827 resolve to exactly one order, 493 to more than
one** because the receipt took that item against several, 25 to a receipt naming
no order for that item, 4 to no source at all. Collapsing the 493 to one would be
the checker inventing a correspondence — `docs/bugs/0690`, two identical
bedframes paired backwards. All candidates are carried and gates 3 and 4 must
hold for every one of them.

**What proves it is not an amnesty.** `tests/acNotADifference.test.ts` — a
document we hold the order for, a source of the wrong type, an unattributed
line, a document with no line key, an ambiguous hop with one held candidate, and
a document carrying one covered line and one real one, all stay counted. Each
gate was mutation-checked: disabling any one of the six makes a test fail
(observed 2026-09-10, `1-4 failed` per mutation, restored green at 64 passed).
`tests/migratedChainShapeWiring.test.ts` pins the wiring so a refactor cannot
unhook it, which is the failure `docs/bugs/0746` recorded.

**Ref.** `feat/pi-source-po-not-migrated`, 2026-09-10. Related: `docs/bugs/0767`
(the refuted document-grain hypothesis), `docs/bugs/0668`, `docs/bugs/0690`.
