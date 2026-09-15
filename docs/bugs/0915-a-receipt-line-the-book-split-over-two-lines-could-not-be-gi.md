## A receipt line the book split over two lines could not be given its AutoCount key [low]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The stamp plan of 2026-09-14 reported HC-GRN-2609-008 as
`ambiguous_in_book`, and the receipt stayed keyless.

The receipt had also been cleared from the AutoCount Sync page on 2026-09-10 by
`archive-ac-outbox-docs.mjs` while its last edit was still refused. On
2026-09-15 it was the only one of the page's 22 cleared documents that had not
reached AutoCount.

**Root cause (traced).** Both sides were read on 2026-09-15:

- **ERP.** One row, DSL-SQUARE PILLOW x3, received from purchase line 907143, with
  no key.
- **Book.** That transfer is split over two lines, 928497 x2 and 928499 x1, each
  with `DocTransfer` naming 907143. Beside them sits 928501 x2 from 907145, which
  is keyed.

`planDocumentKeys` (`backend/scripts/lib/conversion-line-key-plan.mjs`) refused
any source key that fed two lines of one document. It had no quantities, so it
could not tell a split transfer from two different rows.

**Fix.** A new outcome, `stamp_merged`, applies when all of these hold:

- the caller supplies quantities;
- exactly ONE ERP row carries the source;
- the book lines for that source add up to that row's quantity;
- none of those book lines is transferred onward.

The row then takes the lowest-keyed book line. The other lines stay unclaimed,
and `retire-book-only-conversion-lines.mjs` zeroes them, so the book ends with the
one line the ERP holds.

`stamp-conversion-line-keys.mjs` now passes the ERP quantity and the snapshot's
`qty` and `transferredOn`. The drain passes no quantities, so it refuses exactly
as before, and it stores only the `stamp` outcome in any case.

Pinned in `backend/tests/conversionLineKeyPlan.test.mjs` with the receipt's
production lines. On the unfixed tree 2 tests fail (the receipt and the outcome
tally); after the fix all 9 pass. Controls cover a split that does not add up,
two rows on one source, a line held downstream, and no quantities.

The pairing rule's own self-test gained both cases.

Whether AutoCount carries the purchase line's received quantity from 928499 over
to 928497 in the same save is UNTESTED; read that line in the book after the send.

**Ref.** fix/ac-not-accepted-0915, 2026-09-15.
