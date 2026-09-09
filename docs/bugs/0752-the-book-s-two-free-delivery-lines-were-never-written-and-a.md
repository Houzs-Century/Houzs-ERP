## The book's two free delivery lines were never written, and a topped-up line lost its build text [medium]

**Symptom.** Two delivery notes hold fewer lines than the account book, and
neither gap costs a sen — both missing lines are RM 0.00, so no total moved and
nothing flagged them until the line-count comparison did.

```
HC-DO-011465  the book has 2 lines, the ERP has 1
              missing: HOK-SQUARE PILLOW x4 @ RM 0.00
              the book's own Desc2: "for conpesantion wrong item delivery."

HC-DO-010332  the book has 2 lines, the ERP has 1
              missing: DSL-8050 SOFA x1 @ RM 0.00
              the book's own Desc2: "BO315-11 metal/75cm/1S"
              (the line it sits beside is the PRICED one, 2 x RM 3,250, Desc2 ".../2S")
```

The customer was given four pillows to make up for a wrong delivery, and the
delivery note in the ERP does not say so.

**Root cause (traced).** Not a defect in a rule — an ABSENCE from a named list.
`topup-ac-lines-from-truth.mjs`'s DO lane is deliberately not general (its own
header explains why: `delivery_order_items.linked_ac_dtlkey` is being backfilled
and the state moves under the tool, so a rule would be writing on a guess). It
writes only the documents named in `DO_TARGETS`, and these two were never named.

A second defect was found while adding them, and it is the one that would have
recurred silently: the DO insert wrote `description2` as a hard-coded **NULL**.
Every line the lane has ever topped up therefore landed without the build text
the book states for it, on a note whose other rows all carry theirs —
against 「autocount怎么写我们就怎么写」.

**Fix.** Two entries added to `DO_TARGETS`, and the insert now carries
`book.DO.desc2.get(dtlKey)` — the account book's OWN Desc2 for that line, not a
value typed into the target.

`DO_TARGETS` moved to `scripts/lib/do-topup-targets.mjs` so a test can read it.
That is the real remedy here: a named list is a set of hand-typed assertions
about a book nobody re-reads, and the script's own drift check only runs when
somebody dispatches it against production — the wrong moment to find a typo.
`tests/doTopupTargets.test.mjs` now resolves EVERY target against the committed
book snapshot on every PR: document, DtlKey, quantity, unit price, line
subtotal, item code, and the presence of the Desc2 the insert carries. Its last
case plants four real typo shapes — a wrong quantity, a wrong price, a wrong
DtlKey, a wrong document — and asserts each is rejected, because a checker that
cannot catch a planted defect reports a clean run over real data.

**No money and no stock moves.** Both lines are RM 0.00, so each note's header
total is unchanged and still equals the book's. Both parent documents are
re-measured for stock movements by `probe-doc-alignment` immediately before the
apply — a free line onto a note that has already shipped would move an on-hand
figure, and 「库存先不看」 forbids that.

**One thing is stated rather than dressed up.** `HC-DO-011465` gets no declared
`description`: the book's LineDesc for that line is in no cut this repo holds —
`ac-partial-dos.json.gz` and `ac-fidelity-do-lines.json.gz` were both cut before
the note existed (2026-09-04 against a fidelity export of 2026-08-11) — so the
write falls back to the book's own ItemCode. That is the least-wrong copy
available. A LineDesc typed from memory would be an invention.

**Ref.** `fix/book-line-align-seven`, 2026-09-09.
