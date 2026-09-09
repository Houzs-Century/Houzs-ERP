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
`linked_ac_dtlkey` carrying the book's own line key.

**The tie is the STAMPED key, not the item code — and that correction was bought
by running it.** The first cut of this fix matched our receipt row to the book's
invoice line on item code and quantity. Dry run 34364714219 (prod, read-only)
matched **2 of 657** lines: our row's code is the HOUZS code and the book's is
the SUPPLIER's model, so `CASUAL-(K)` here is `NB-KHJ57(SS)` there. The pairing
is therefore done in two halves, each on evidence that exists:

- **our row -> the book's receipt line** by `scm.grn_items.linked_ac_dtlkey`,
  stamped by `backfill-ac-downstream-line-keys.mjs` (run 34355496796, APPLY,
  2026-09-09: **576 of 812** company-1 receipt rows carry one). A row without
  one is reported and refused, never guessed;
- **the book's receipt line -> the book's invoice line(s)** on item code,
  quantity, unit price and amount — both sides are AutoCount's own figures
  there, which is the one comparison `lib/ac-forced-line-pairing.mjs` says is
  trustworthy. Never by position (`docs/bugs/0690`, `docs/bugs/0730`).

A sofa is ONE line in the book and one row per compartment here, and the
backfill gives every compartment the same key by design, so the invoice gets ONE
line and its `grn_item_id` is left NULL rather than pointed at whichever
compartment sorts first; `linked_ac_dtlkey` carries the identity. All of that
line's compartment rows are consumed when it is invoiced.

Because the book's line states which invoice it is on, a receipt billed across
several invoices is now SPLIT into one ERP invoice per book invoice instead of
refused; `ambiguous_autocount_invoices` cannot arise on this path any more.
`src/scm/lib/migrated-chain.ts` is untouched — it receives documents that
already carry the book's lines and name one invoice each.

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

**Proved.** `backend/tests/acPiBookLines.test.mjs`, 12 tests, all built from the
document numbers above. Three halves were RUN RED against the unfixed rule, not
asserted to be red:

- pass 2 disabled -> `follows the book when it SPLITS one receipt line across two
  invoices` fails, `AssertionError: expected [ { lineId: 'two-eight-fifty',
  ...(3) } ] to deeply equal []`.
- the discount left at 0 instead of derived -> 3 fail, including
  `AssertionError: expected { discountSen: +0, reconciles: true } to deeply equal
  { discountSen: 1483, reconciles: true }` — 1483 being the 3 x 32.94 vs 83.99
  gap above.
- the price ignored in the first pass -> `keeps the price with the right line
  when one receipt holds the same item at two prices` fails,
  `AssertionError: expected [ '728225' ] to deeply equal [ '728240' ]` — the
  920.00 receipt line coming away with an 850.00 amount.

Restored, 12 of 12 pass.

**Measured over the whole book**, every AutoCount goods receipt an invoice was
raised from (21,458 receipt lines across 5,251 receipts, 5,259 usable invoices
after 4 cancelled and 20 foreign are removed):

| | |
|---|---|
| book receipt lines paired to an invoice line | **21,432** |
| receipt lines AutoCount never invoiced | 30 |
| invoice lines pairing to no receipt line | 1 |
| receipt lines the book SPLIT across invoice lines | 4, all 4 across more than one invoice |
| 1:1 pairings whose unit price moved | **0** |
| lines where `qty x unit_price - discount` reproduces the book's amount to the sen | **21,431 of 21,432** |

The one that does not is `PI-006292` line 763237, `AN-DINING CHAIR` 6 x 112.81 =
676.86 against the book's **676.88**. It is a SURCHARGE, and the ERP has no
column for one — so the book's amount is still what `line_total_sen` carries and
only the arithmetic between the other two columns falls 2 sen short. It is
counted and printed, not hidden.

**What it produces on production, dry run 34365807410 (read-only, 2026-09-09).**
473 migrated goods receipts; 412 with something left to invoice, carrying 657
lines. **506 of 657 carry the book's line key** — 459 distinct book receipt
lines, the gap being sofa compartments that share one. The book's invoices bill
**362** of those 459. The run would write **141 invoices** made of **362 lines,
every one copied from PIDTL**, of which 31 stand for several of our rows and
carry no single `grn_item_id`. Refused: 72 receipts where NO row carries a book
line key, 61 with nothing left to invoice, 57 the book's invoices bill none of.
No invoice was created; the apply is the owner's.

Before this change the same run planned 159 invoices — but from our own receipt
rows, whose line amounts were not required to be the book's. The 18 difference
is receipts whose rows carry no book line key, and those are **not waiting on
the line-key backfill**: it ran to exhaustion on this same book cut
(run 34355496796, APPLY, 2026-09-09 13:11Z, "0 to stamp ... 576 already keyed;
73 NOT stamped") and REFUSED them — two lines of one item it cannot tell apart,
an uneven sofa fold, or an item the book has no matching line for. Recovering
them is an owner decision, not a re-run.

**A note that is not about invoices.** `scm.write_freeze` is enforced in the HTTP
layer (`backend/src/scm/index.ts`). This script opens Postgres directly and never
reads it, so freezing the module does not gate this run — restated from
`docs/bugs/0764` because it stays true of every repair script here.

**Ref.** `feat/pi-lines-from-book`, 2026-09-09.
