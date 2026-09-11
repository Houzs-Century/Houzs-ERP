## A free delivery line the book gives away was never written, and every topped-up line lost its build text [medium]

**Symptom.** A delivery note holds fewer lines than the account book, and the
gap costs nothing — the missing line is RM 0.00, so no total moved and nothing
flagged it until the line counts were compared.

```
HC-DO-011465  the book has 2 lines, the ERP has 1
              missing: HOK-SQUARE PILLOW x4 @ RM 0.00
              the book's own Desc2: "for conpesantion wrong item delivery."
```

The customer was given four pillows to make up for a wrong delivery, and the
delivery note in the ERP does not say so.

**Root cause (traced).** Not a defect in a rule — an ABSENCE from a named list.
`topup-ac-lines-from-truth.mjs`'s DO lane is deliberately not general (its own
header explains why: `delivery_order_items.linked_ac_dtlkey` is being backfilled
and the state moves under the tool, so a rule would be writing on a guess). It
writes only the documents named in `DO_TARGETS`, and this one was never named.

A second defect was found while adding it, and it is the one that would have
recurred silently: the DO insert wrote `description2` as a hard-coded **NULL**.
Every line the lane has ever topped up therefore landed without the build text
the book states for it, on a note whose other rows all carry theirs —
against 「autocount怎么写我们就怎么写」.

**Fix.** One entry added to `DO_TARGETS`, and the insert now carries
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

**No money and no stock moves.** The line is RM 0.00, so the note's header total
is unchanged and still equals the book's. Stock was re-measured, not recalled:
`probe-doc-alignment` run 34328818076, snapshot 2026-09-09T08:23:41Z, printed
`HC-DO-011465  STOCK MOVEMENTS: 0`. A free line onto a note that has already
shipped would move an on-hand figure, and 「库存先不看」 forbids that.

**A SECOND target was written and then REMOVED, by that same probe.**
`HC-DO-010332` looked like exactly the same shape — a missing `DSL-8050 SOFA` at
RM 0.00, book DtlKey 836941 — and it passed every book assertion. Then the live
row was read:

```
HC-DO-010332  1 line
  item 8050-1S  qty 2 @ RM 3,250   ac_dtlkey 836939
  description2 "BO315-11 metal/75cm/1S"
```

Our one row is KEYED to the book's **2S** line (836939, `2 x RM 3,250`,
Desc2 `.../2S`) while carrying the **1S** line's build text — and its item code
says 1S as well. Inserting the free line on its own would have left the note
with two rows both claiming 1S, one of them priced at the other line's money.
The existing row has to become the 2S line FIRST, and that is a SEAT SIZE on a
delivered document: 「never invent a seat size」, and a seat change belongs to
the sofa tooling, not to a top-up that copies quantities and prices.

`tests/doTopupTargets.test.mjs` now pins its ABSENCE, with the two book texts
beside each other, so it cannot be re-added as a simple top-up. **This is what
plan-then-observe is for: the target satisfied every check the book could make
and was still wrong.**

**One thing is stated rather than dressed up.** `HC-DO-011465` gets no declared
`description`: the book's LineDesc for that line is in no cut this repo holds —
`ac-partial-dos.json.gz` and `ac-fidelity-do-lines.json.gz` were both cut before
the note existed (2026-09-04 against a fidelity export of 2026-08-11) — so the
write falls back to the book's own ItemCode. That is the least-wrong copy
available. A LineDesc typed from memory would be an invention.

**Ref.** `fix/book-line-align-seven`, PR #3419, 2026-09-09.
