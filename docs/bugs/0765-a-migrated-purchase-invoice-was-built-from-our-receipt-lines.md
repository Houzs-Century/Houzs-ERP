## A migrated purchase invoice was built from our receipt lines, not the book's invoice lines [high]

**Symptom.** The owner, 2026-09-09, after `docs/bugs/0764` shipped
`ALLOW_TOTAL_MISMATCH=1`: 「就是每一个 line item 都要跟 autocall 一样啊」 and then,
sharpening it, 「total amount不需要 可是line amount一定一样」. The invoice TOTAL
need not equal AutoCount's; every LINE AMOUNT must. `docs/bugs/0764` had asserted
that this was already true — *"a receipt's lines ARE the book's lines, and writing
an invoice from them writes the book's lines"* — and it is not.

**Root cause (traced, not guessed).** `create-migrated-invoices.mjs` built the
purchase invoice's lines out of `scm.grn_items` and computed each amount as
`qty x unit_price - discount` (`writePi`, and `lineValueSen` in
`src/scm/lib/migrated-chain.ts`). Two shapes in the account book make that
unable to equal `PIDTL`, whatever price is put on it. Both were read out of
`backend/scripts/data/ac-reconcile-truth.json.gz` (cut 2026-09-09T00:18:49Z) with
`decodeSnapshot`:

1. **The book SPLITS one receipt line across two invoices.** `GR-003813` line
   706719 is `HOK-2008(A) (K)` **qty 2 @ 850.00**. `PI-006011` line 728225 bills
   **1** of it and `PI-006012` line 728248 bills the other **1**. One ERP row
   cannot become two invoice lines on two invoices, so the old converter could
   not produce that shape at all — and the planner refused the whole receipt as
   `ambiguous_autocount_invoices` (7 receipts on the 2026-09-09 dry run,
   run 34361435703).

2. **AutoCount rounds an amount-shaped discount differently on its own two
   documents.** `GR-001910` line 410660 is `3 x 32.94` and the book's RECEIPT
   says **84.00**; `PI-002949` line 410782 says **83.99**. Same again on
   `GR-003750` line 700960 — receipt 12,093.52, `PI-005629` 12,093.51. Neither
   equals `qty x unit`, so no figure derived from a quantity and a unit price
   reproduces them. Only copying the INVOICE line does.

**Fix.** The purchase invoice is now built from `PIDTL` and nothing else — item,
quantity, unit price and amount all copied, with the ERP's `discount_sen`
derived so its three columns reconcile to the book's amount, and
`linked_ac_dtlkey` carrying the book's own line key. Each line is tied to the
goods-receipt line it bills by item code and quantity inside the one receipt the
book names, in two passes (exact, then the split above), never by position —
`scripts/lib/ac-pi-book-lines.mjs`, whose rules are `lib/ac-pi-gr-line-match.mjs`'s
and `lib/ac-gr-po-line-match.mjs`'s, taken for the reason `docs/bugs/0690` and
`docs/bugs/0730` record. Because the book's line states which invoice it is on,
a receipt billed across several invoices is now SPLIT into one ERP invoice per
book invoice instead of refused; `ambiguous_autocount_invoices` cannot arise on
this path any more. `src/scm/lib/migrated-chain.ts` is untouched — it receives
documents that already carry the book's lines.

The purchase half no longer reads `ac-invoice-refs.json.gz` at all: the invoice,
its lines, its date and its cancellation all come from the one snapshot, so a
plan can no longer describe two vintages at once. Its freshness gate now applies
to the sales half, which still reads it.

A foreign-currency purchase invoice is REFUSED rather than converted. The book
states a line twice — `LocalSubTotal` in MYR and `SubTotal` in the document's
currency — while the migrated purchase order was written with a hard-coded MYR,
so mixing them books an exchange rate as a discount (`docs/bugs/0665`, RM
13,068.55). 20 of the book's 5,283 purchase invoices are foreign and none is in
scope today.

**Proved.** `backend/tests/acPiBookLines.test.mjs`, 11 tests, all built from the
document numbers above. Both halves were RUN RED against the unfixed rule, not
asserted to be red:

- pass 2 disabled -> `follows the book when it SPLITS one receipt line across two
  invoices` fails, `AssertionError: expected [ { lineId: 'two-eight-fifty',
  ...(3) } ] to deeply equal []`.
- the discount left at 0 instead of derived -> 3 fail, including
  `AssertionError: expected { discountSen: +0, reconciles: true } to deeply equal
  { discountSen: 1483, reconciles: true }` — 1483 being the 3 x 32.94 vs 83.99
  gap above.

Restored, 11 of 11 pass. Measured over the whole book
as well — all 1,292 goods-receipt lines of the 163 AutoCount receipts in the
2026-09-09 plan: **1,287 pair to a book invoice line, and for all 1,287 the
ERP's `qty x unit_price - discount` reproduces the book's amount to the sen; 0
do not.** The 5 that do not pair are AutoCount not having invoiced them
(`GR-004478` holds 4 such lines, `GR-004747` bills 1 of a 2-unit line).

**A note that is not about invoices.** `scm.write_freeze` is enforced in the HTTP
layer (`backend/src/scm/index.ts`). This script opens Postgres directly and never
reads it, so freezing the module does not gate this run — restated from
`docs/bugs/0764` because it stays true of every repair script here.

**Ref.** `feat/pi-lines-from-book`, 2026-09-09.
