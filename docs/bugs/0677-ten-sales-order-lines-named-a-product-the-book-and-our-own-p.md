## Ten sales-order lines named a product the book and our own purchase order both disagree with [high]

<!-- area: Cutover + migrated data -->

**Symptom.** The sofa document-chain audit went `SO -> PO MISMATCH code 0` at
19:54 MYT to `MISMATCH code 9` at 22:02 MYT on 2026-09-07: nine customers' beds
dedicated to a purchase-order line for a different bed. `docs/bugs/0668` removed
the wrong dedications (run **34138205774**, 10 of 10, verified on a fresh
connection) and deliberately wrote no correction, because *which side is right*
was the owner's call. He ruled on 2026-09-08 at ~00:25 MYT: **follow AutoCount,
correct the sales order.**

**Root cause (traced).** Not the dedication - that was the symptom, and 0668/0671
own it. The defect this entry is about is one step earlier, in the migration
itself: **the sales-order line's `item_code` is not the code AutoCount's own
SODTL row carries.** Measured against the two committed snapshots, without
opening the book:

- `ac-po-fromsodtlkey.json.gz` (cut 2026-09-07 17:37 MYT) carries 697 PODTL
  SO-edges. Decoding `ac-reconcile-truth.json.gz` (cut 2026-09-07 22:12 MYT),
  **every edge behind these ten pairs an SODTL row and a PODTL row whose
  `ItemKey` strings are byte-identical** - `HOK-2008(A) (K)` on both ends,
  `HOK-1013 (Q)` on both ends, `AMN-SQUARE PILLOW` on both ends.
- `autocount-erp-mapping-1561.csv` turns that one code into one ERP code, and it
  is the code **our purchase-order line already carries**.

So the book agrees with itself, and it agrees with our purchase order. The row
that disagrees with its own source is the sales-order line, and it disagrees
because the importer's code resolution
(`import-ac-outstanding-so.mjs:234-249`) produced a different answer for that
line than the same mapping sheet gives today.

**Why it is worth a repair and not a note.** A bedframe or sofa line is
HARD-BOUND (`isHardBoundLine`, `src/scm/lib/so-stock-allocation.ts`): it reads
READY only through its OWN dedicated purchase order's `received_qty`, never
through the pooled balance. With the wrong code on the sales-order line, the
identity guard added in PR #3076 correctly REFUSES to dedicate it - so the line
can never light, correctly and permanently, until the code is right.

**Fix.** `backend/scripts/correct-so-item-code-from-autocount.mjs` +
`backend/scripts/lib/so-item-code-correction.mjs` +
`.github/workflows/correct-so-item-code.yml`.

The population is MEASURED, never listed: every PODTL SO-edge is resolved
through the book, the mapping sheet and `linked_ac_dtlkey`, and a line whose
code already agrees is counted and skipped - an eleventh disagreement would be
found without editing the file.

**THE THREE FIELDS THAT FOLLOW THE PRODUCT, AND THE FOUR THAT DO NOT.** This is
the whole of the risk, because changing an item code can move money and
variants, and a wrong price on a customer's order is worse than a wrong product
name. `item_code`, `item_group` and `description` follow, and they are exactly
the three the importer derives from the AutoCount item code
(`:234-249`, `:323-326`). `qty`, `unit_price_sen`, `total_sen`,
`variants` and `custom_specials` do **not**, and the reason is not a preference:
the importer copied every one of them from the **same** `SODTL` DtlKey this
correction is agreeing with - the money from `SODTL.Qty`/`SODTL.UnitPrice`
(`:257-258`), the variants parsed from that row's own `Desc2`. The item code was
mis-RESOLVED; the money and the customer's choices came from the row we are now
agreeing with, so correcting the code cannot make either more or less faithful.
The plan prints the book's own price beside the stored one for every line, so
"the price does not move" is a measurement in the log and not a sentence in a
comment. Where the two differ because the BOOK states 0.00, the standing rule is
that a blank never overwrites a value (`docs/bugs/0675`) and this script does not
touch it.

Four guards, each of which refuses rather than adapts:

| guard | why |
|---|---|
| a DtlKey claimed by more than one ERP row is REFUSED | `linked_ac_dtlkey` is NOT unique - one AutoCount sofa line is one ERP row per compartment, and a keyed repair that ignored that proposed RM 2,216,501 of invented revenue (`docs/bugs/0673`) |
| the target code must exist in `scm.mfg_products` for the company | the stored string has to be byte-identical to a picker-chosen one; a code our own pick list cannot resolve is refused, never invented |
| the OLD code and the AutoCount key are re-asserted inside the `UPDATE` | a row a person corrected between plan and apply is not overwritten, and shows up in the count |
| the fresh-connection re-read asserts the SHAPE | not a row count: what the code, group, name, quantity, unit price, line total, variants and specials NOW are, and it exits non-zero if anything that must not move did |

`backend/tests/soItemCodeCorrection.test.mjs` pins the rule: the happy path, the
two refusals, the de-duplication of one sales-order line named by several
purchase-order lines, and - the point of the exercise - that the plan carries
the money and the variants it read and proposes no new ones.

**RE-RUN: convergent.** The population is every line whose code still disagrees,
so a second apply finds nothing left and exits 0 without writing.

**What this deliberately does NOT do.** It writes no dedication. Re-linking is
`sync-ac-delta` lane `links`, whose item-identity guard (PR #3076) is the thing
that must pass on its own once the codes are right - a correction that also
wrote the link would be marking its own homework.

**Ref.** fix/golive-3rulings-2026-09-08, 2026-09-08. The production plan and
apply runs are recorded in the follow-up entry
`0678-the-runs-behind-the-2026-09-08-owner-rulings.md`.
