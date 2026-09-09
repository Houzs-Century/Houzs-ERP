## The three receipts AutoCount discounted could never take the book's money [high]

**Symptom.** `HC-GR-005363`, `HC-GR-005367` and `HC-GR-005368` each read exactly
the account book x 4/3 — AutoCount took 25% off and our importer did not. The
owner ruled on them directly, 2026-09-09: 「这三个就跟着line item去跟着autocount就
对了 autocount怎么写我们就怎么写」. `repair-gr-money-from-book` was written for
exactly them, and every plan run REFUSED all three:

```
HC-GR-005363: REFUSED — 2 of 4 line(s) carry no AutoCount line key
HC-GR-005367: REFUSED — 2 of 2 line(s) carry no AutoCount line key
HC-GR-005368: REFUSED — 2 of 2 line(s) carry no AutoCount line key
```
(run 34313911486, MODE=plan, read-only.)

**Root cause (traced).** The refusal is correct and the named remedy could never
run. `backfill-ac-downstream-line-keys.mjs` stamps a key only where the document
FORCES which book line an ERP row is (`lib/ac-forced-line-pairing.mjs`). On these
receipts it cannot: measured on production 2026-09-09 by `probe-book-line-gaps`,
run 34314996219, `HC-GR-005363` holds two `AKEMI BASTION MATT (Q)` rows that are
identical in every column and carry **no `description2` and no
`purchase_order_item_id`**, against two book rows whose ONLY difference is the
venue in `Desc2` — "Perak … STADIUM INDERA MULIA" against "Pulau Pinang …
PENANG WATERFRONT CC". Clause 2 of the pairing rule needs our rows to carry a
build text and they carry none; clause 3 needs the book rows to be mutually
identical and their `Desc2` differs. So neither the key nor the money could ever
land, and the receipts were permanently stuck.

**Fix.** `lib/gr-money-from-book.mjs` grows a keyless arm that writes **money and
never identity**. When every unclaimed book row of one item code states the same
quantity, the same `UnitPrice` and the same `SubTotal`, the figure is the same
whichever ERP row is whichever book row — so the money is FORCED even though the
identity is not. It stamps no key: `lib/ac-forced-line-pairing.mjs` keeps the
right to refuse, because a wrong key makes AcSyncService edit somebody else's
line in the live book (migration 0273). Where the candidates differ on any of
those three, or the two sides hold a different NUMBER of rows for a code, or a
PRICED book row nothing answers is left over, the whole receipt is refused
exactly as before. An unclaimed book row at RM 0.00 is allowed — AutoCount bills
a free gift as its own line, which is the rule `check-ac-erp-reconcile.mjs`
already states. The new parameter is absent by default and its absence is the
STRICTER direction, so no caller can loosen anything by saying nothing.

Proved RED on the unfixed tree: `node --test
backend/scripts/lib/gr-money-from-book.test.mjs` — **pass 18, fail 5**. Green
after: pass 23, fail 0. The added cases are the real production rows, and three
of them are the negative gates: book rows that state different money, a keyless
row with no candidate of its own, and a priced book row nothing answers all keep
the receipt refused.

**Ref.** fix/book-line-inserts, 2026-09-09.
