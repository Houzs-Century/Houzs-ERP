## Three more ways one goods receipt could be billed twice — and the confirm that clamped instead of refusing [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** None reported. Found by reading the newly-added GRN -> Purchase
Invoice unlinked-line guard back three times before shipping it, once for the
predicate, once for what could reach the same money outcome WITHOUT passing
through it, and once for what the change itself broke. The predicate was right in
all three readings. Its reach was not.

**Root cause 1 — the guard checked ONE receipt; an invoice covers several.**
A purchase invoice is line-level multi-receipt by design. Migration
`0267_grn_outstanding_line_level.sql` records the ruling (owner 2026-08-06): *"the
PI header's `grn_id` is only the PRIMARY note ref, while the authoritative linkage
is per line"*, and `POST /from-grn-items` stamps `grn_id: bucket.grnIds[0]` under
its own comment saying exactly that. The guard read that single ref. So an invoice
covering HC-GRN-2608-011 (FABRIC-KN390) and HC-GRN-2608-012 (FOAM-40D 20 accepted,
invoiced 0) accepted a hand-typed FOAM-40D line: not on note 011, therefore
"genuinely ad-hoc", therefore allowed — the refused shape, one note over. Note
012's line kept reading remaining 20, stayed in the outstanding picker, and a
second invoice billed it.

**Root cause 2 — `PATCH /:id/items/:itemId` had no guard at all.** It maps
`materialCode -> material_code` and never touches `grn_item_id`, so the shape
assembles in two legal steps: add PACKING-FILM by hand (correctly allowed — the
receipt does not contain it), then edit that line's product to FOAM-40D. Neither
the qty cap nor the invoiced-qty recount fires, because both read the STORED link,
which is still null — while `recomputePiTotals`, `resyncPiAccounting` and
`queueAcPiEdit` all move. The shipped UI drives it: `PurchaseInvoiceDetail.tsx`'s
change-detector compares `d.materialCode !== it.material_code` and puts
`materialCode` in the PATCH payload. This router already knew lines get retyped
after creation — its charge-reallocation note describes *"a row that used to be
goods and was later retyped as freight"*.

**Root cause 3 — the guard's own read FAILED OPEN.** An empty parent-code set is
an unconditional pass (`do-unlinked-so-lines.ts`: `if (ordered.size === 0) return
[];`) and the read that filled it dropped its error, so a statement timeout
answered *"nothing to find"*. That is the same fail-open `piLocked` **in this very
router** was fixed for: *"A failed read must never read as an absence when the
absence is what authorises the write."*

**Root cause 4 — the DRAFT confirm never re-checked the cap, and the counter
CLAMPED.** Both over-invoice re-sums exclude DRAFT invoices — right, a draft
consumes nothing — on the strength of a comment claiming *"The cap is re-checked
at confirm (recomputeGrnInvoiced clamps to qty_accepted), so a DRAFT that would
over-bill is caught the moment it's confirmed."* It was not.
`recomputeGrnInvoiced` clamps (`Math.min(accepted, inv)`) and is contractually
*"best-effort, never throws"*, so it can refuse nothing. Two clerks each drafting
an invoice for all 12 units of a 12-unit receipt line both confirmed, both posted
AP at 576,000 sen, and the clamp left `invoiced_qty` reading 12 of 12 — **every
counter a reconciliation reads said the receipt was billed exactly once.**

**Fix.** `findUnlinkedPiLines` now takes a SET of receipts and returns a verdict
rather than a bare array. `coveredGrnIds` in `purchase-invoices.ts` derives that
set the way this router already derives it twice for reads — header ref UNION the
receipts behind the invoice's own linked lines (`grn_item_id -> grn_items.grn_id`).
All three paths that can reach the shape now call it — `POST /`, `POST /:id/items`
and `PATCH /:id/items/:itemId` (on the EFFECTIVE post-patch code, and only for an
unlinked line, so an ordinary qty edit pays for no extra read) — and every one of
them answers 500 `unlinked_check_failed` when the check cannot run.
`verifyGrnLinesNotOverInvoiced` takes `countDraftPiId` so the draft being
confirmed counts, and `PATCH /:id/post` calls it BEFORE the `DRAFT -> POSTED` flip
and again after, reverting to DRAFT if a concurrent confirm won the race. That is
the per-line invariant Σ(billed so far) + this bill <= received qty, **not** an
"already invoiced" flag — a receipt line still bills across several invoices and
every partial passes. The three reads inside that function bind their errors too:
the CREATE paths log and proceed (each ran its own pre-check moments earlier), the
CONFIRM refuses, because there the pre-check is the only check. The false comment
is corrected in place.

**The refusal message was also wrong twice.** It said *"Pick those items from the
Goods Receipt instead of adding them by hand"* — on the invoice DETAIL editor,
where it fires most, there is no receipt-line picker and the add payload cannot
carry a `grnItemId`, so a correctly-refused operator was dead-ended and the way
out of a dead end is to retype the code until it stops matching. It also promised
a freight or service line was *"unaffected"* full stop, which is false when the
receipt carries its own service line. And it named the receipt by raw uuid: no
client sends `grnNumber` on create, and the add path passed the id as the label.
Each offender now names the receipt NUMBER that carries its material.

**Tests.** `return-unlinked-lines.test.ts` 15 -> 26. Three wiring slices, each
BOUNDED AT BOTH ENDS — the add-line slice previously ran to end-of-file, so a
guard in a different handler could have satisfied it. Proven not vacuous: deleting
the PATCH guard fails 2 tests; dropping `countDraftPiId` from the confirm fails 1.

**Deferred, recorded not fixed.** The identical edit-path gap exists on all five
sibling chains — `grns.ts`, `purchase-returns.ts`, `delivery-returns.ts` and
`sales-invoices.ts` all map an item code in a line PATCH whose handler calls no
unlinked guard — and the shared `grnMaterialCodesOf` / `poMaterialCodesOf` /
`soItemCodesOf` readers still swallow their errors for those chains. Those move
STOCK; this one moved money, which is why only this one is closed here. See
`docs/unlinked-line-duplicate-coe.md` §5a and §8.

**Ref** — the guard itself is the entry above. Reviews: money-correctness,
bypass-enumeration and regression, all 2026-08-17.
