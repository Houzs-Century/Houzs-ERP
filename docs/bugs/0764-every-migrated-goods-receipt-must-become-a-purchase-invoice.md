## Every migrated goods receipt must become a purchase invoice, and the total gate was stopping 288 of them [medium]

**Symptom.** `create-migrated-invoices.mjs`, dry run 34356182401: of 473 migrated
goods receipts, 29 invoices worth RM 130,806.50 were writable and **288 were
refused for `total_disagrees_with_autocount`** — our receipt's line value against
what AutoCount's purchase invoice billed. Examples run to ours RM 1,365 against
the book's RM 8,025.

**The owner's rule, 2026-09-09, which settles it:**

> 我们现在有的 GR 基本上都是要 convert 成 invoice 的。我们有几张 GR 就要 convert
> 成几张 invoice。可是它的 invoice 不需要提取总价钱，你就拿 line item 就可以了

and the business reason, in the next message:

> 你从 AutoCount 来的 GR 都一定要转成 Purchase Invoice，要不然它就会永远挂成一个
> Outstanding 了

**Root cause (traced, not guessed).** The gate is
`migrated-chain.ts:279` — `eligible = !partySplit && (opts.allowTotalMismatch ===
true || (acValueSen >= 0 && acValueSen === valueSen))`. It requires our figure to
EQUAL the book's invoice total.

That equality is not a law of the data. **One AutoCount purchase invoice can span
several receipts**, which the same file already knows — its own report line says
*"folds AutoCount receipts A + B into one ERP receipt"*. When the book bills two
receipts on one invoice, a per-receipt comparison must differ, and it is the
book's grouping that differs, not our money.

**Fix.** `ALLOW_TOTAL_MISMATCH=1`, wired to the `allowTotalMismatch` option the
planner already carried and the runner never exposed. Opt-in per run, never the
default.

**The owner sharpened it, and it shrinks the cost below.** 「就是每一个 line item
都要跟 autocall 一样啊」 — every LINE ITEM must match AutoCount; it is only the
invoice TOTAL that is not required to. That is already true of the source: the
goods receipts were reconciled to the book line by line earlier the same day
(`repair-gr-money-from-book.mjs`, and the owner's rulings on the 25% discount and
the RM 55), and the PO/GR tally now reads 400 receipts with ONE differing, which
he accepted (`docs/bugs/0762`). So a receipt's lines ARE the book's lines, and
writing an invoice from them writes the book's lines.

**What is given up, said plainly, and it is smaller than the first draft of this
entry claimed.** The total equality was doing a second job:
the script recovers a price the cutover dropped (483 of 496 migrated GRN lines
carry no price) by reading it back off the order line, and the file's own comment
names the total gate as the proof that a recovered price is right —
*"an invoice whose recovered prices are wrong fails that test rather than being
written"*. **With the gate off, nothing IN THIS SCRIPT catches a wrong recovered price** —
but the receipt lines it copies were already reconciled to the book by a
different lane, which is the check that actually matters and which the total gate
was only a proxy for. Still opt-in and printed in the run's first line: a proxy
that is usually redundant is not the same as one that is never needed.

**A second thing found while doing this, which is not about invoices at all.**
`scm.write_freeze` is enforced in the HTTP layer (`backend/src/scm/index.ts:127`).
`create-migrated-invoices.mjs` connects straight to Postgres and never reads it —
`grep` returns zero hits. **A frozen module does not stop a back-end script**, so
"the module is locked" is a statement about the floor, never about a repair run.

**Ref.** PR for `feat/pi-allow-total-mismatch`, 2026-09-09.
