## 70 migrated purchase orders carry a header total of zero while their lines are priced [medium]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

> **THE POPULATION IS NOW ZERO — measured 2026-09-08, nothing to repair.**
>
> This entry left the repair as the owner's call. He then ruled (recorded in
> `.github/workflows/rollup-po-header-total.yml`, 2026-09-08): **recompute the
> header = add up the lines.** The tool was built to that ruling and merged — and
> **never dispatched, in any mode**, which is how it was still being read as open
> money work a day later.
>
> Dispatched in PLAN mode on 2026-09-08, run
> [34189363302](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34189363302)
> (13:06 local, company 1, writes nothing):
>
> ```
> company 1: 574 purchase order(s) read
>   header already equals its own lines plus tax       71
>   header is ZERO and the lines carry money  <- roll   0
>   header is zero and the lines are zero too         503   (nothing to roll up)
>   header disagrees with its lines but is NOT zero      0
>   REFUSED, the header carries no currency              0
>   REFUSED, the LINES disagree with themselves          0
>   documents this run would write                       0
> nothing to roll up - no purchase order in this company has a zero header over priced lines.
> ```
>
> **The 70 are gone.** 574 is the same denominator this entry quotes, so it is the
> same population. The zero-header-over-priced-lines class is empty, and the 503
> that remain at zero are zero on BOTH sides — the book prices no factory purchase
> order, which this entry already explains and which is not a defect.
>
> **What closed it is not established** (UNKNOWN): the line-discount repair and the
> source-price stamping both re-sum headers, and either could have swept these up.
> The population is what was measured, not the cause of its emptiness. Nothing is
> owed either way — the roll-up tool stays, and a future zero-header document will
> be found by re-running it.

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
