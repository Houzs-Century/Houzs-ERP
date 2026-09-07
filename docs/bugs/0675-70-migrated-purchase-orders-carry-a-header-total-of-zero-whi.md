## 70 migrated purchase orders carry a header total of zero while their lines are priced [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The priced-specials money report (run **34138211541**) printed a
`total now` for every document it listed. Every one of the **70 purchase
orders** read `RM 0.00`; every one of the **157 sales orders** read a real
figure. One whole document type behaving unlike the other.

**It looked like a contradiction, and that is why it is written down.** The
document-level reconcile compares **574 PO document totals and finds almost none
differing** — which it could not do if the ERP side were uniformly zero. Two
things we hold disagreed, so one of them had to be wrong.

**Root cause (traced, not guessed).** Neither was wrong. They measure different
things and both are right:

| step | what happens |
|---|---|
| `import-ac-outstanding-po.mjs`, `import-ac-so-linked-pos.mjs:384` | the header is written as `total_sen = SUM(qty x priceSen)` |
| `import-ac-so-linked-pos.mjs:235` | `priceSen = Math.round(Number(l.UnitPrice ?? 0) * 100)` — AutoCount's own `PODTL.UnitPrice` |
| the book | that price is **RM 0.00** on a large part of the migrated set. The reconcile counts **241 PO lines** where the book says RM 0.00 and the ERP line holds a real figure |
| later | something set those ERP LINE prices to real values and **never rolled the total back up to the header** |

So the header faithfully copied a zero, the book's own total is zero too, and
the reconcile scores `0 == 0` as agreement — correctly. The defect is not in
either check. It is that on these documents **the header total does not equal
the sum of its own lines.**

`scm.purchase_orders.total_sen` is `integer DEFAULT 0 NOT NULL`, so these are
real stored zeros and not a null-read artefact.

**What was done here, and what was NOT.** The money report now refuses to
present a `total after` on a document whose `total now` is zero, and says why —
because `RM 0.00 -> RM 2,000.00` reads like a document value and is not one.
That is a REPORTING fix and it is all this entry ships.

**The repair itself is deliberately not attempted.** Recomputing 70 historical
purchase-order headers from their lines is a money write on migrated documents,
which is the owner's call and not a script's — the same rule that put the priced
specials in front of him rather than stamping them. What the right answer is
also is not obvious: the ERP line prices may be the truth and the header stale,
or the book's zeros may be the truth and the line prices the ones that were
invented. That question needs the owner, and it needs to be asked with the
document list in hand.

**Ref.** fix/po-header-total-stale, 2026-09-07.
