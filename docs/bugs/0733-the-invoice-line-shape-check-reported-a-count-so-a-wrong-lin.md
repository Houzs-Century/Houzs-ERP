## The invoice-line shape check reported a count, so a wrong link on production could not be named [medium]

**Symptom.** `repair-pi-gr-links.mjs` applied 26 links to production in run
[34275605452](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34275605452)
and its own read-back then refused the batch:

```
wrote 26 link(s) of 26 planned
verify (fresh connection): linked 26/26 · dangling 0 · wrong company 0 · wrong item 1
VERIFY FAILED: a link points at another company's receipt or at another item.
```

**The guard worked.** One of the 26 links joins an invoice line to a receipt
line whose `item_code` is different, and nothing else in the run would have
noticed. It is a known problem instead of a silent one because the read-back
asserts a SHAPE — which is the discipline CLAUDE.md's release-discipline rule 3
requires, and it earned its place here.

**What it got wrong.** It reported a **count**. The run ended knowing that one
of 26 links is bad and not WHICH — twenty-six suspects, on live rows, with no
way to act on any of them. A shape check that cannot name its offender throws
away most of the value of having checked, and the operator is left worse off
than a check that had printed the rows and passed.

The write had already happened by then, and that is by design: the read-back
runs after the UPDATE because it verifies what LANDED. The fix is not to check
earlier — a pre-check reads the state that is about to change — it is to make
the failure name itself.

**Root cause of the bad link (traced).** `scripts/lib/ac-pi-gr-line-match.mjs`
pairs on the BOOK's item codes: both sides come from
`ac-reconcile-truth.json.gz`, and the matcher requires them equal, so book-side
a mismatch is impossible by construction. The ERP's own `item_code` is a
separate value on both rows, and for one pair the two do not agree — our invoice
line and our receipt line hold different codes for what the book calls one item.
The matcher never reads our codes, so it could not have seen it; only the
read-back could, and only after the fact.

**Fix.** `scripts/check-pi-gr-link-shape.mjs` reads the committed plan, prints
all 26 links with BOTH our item codes and the book's beside each other, and says
per row which fail. `MODE=revert` then sets `grn_item_id` back to NULL for the
failing rows **only**, and only where the row still holds exactly the value the
plan wrote — if a person has re-pointed it since, their answer wins.

Blank, not a guess: a link whose two sides disagree about the item is evidence
that the derivation is wrong for that row, not evidence of the right answer.
That is the same rule the matcher already follows and the one
`docs/bugs/0730` records — **a blank beats a wrong link.**

**Stock.** One column set to NULL on a handful of rows. `pg_trigger` is read on
the live database first and the run refuses if anything fires on
`scm.purchase_invoice_items` or `scm.grn_items`, exactly as the repair does.
「库存先不看」.

**The lesson worth keeping.** `docs/bugs/` already records "a row count is not a
shape". This is its neighbour: **a shape check that reports only a verdict is
not actionable.** When a guard refuses a batch, it must print the members that
failed — otherwise the next person's only options are to trust the whole batch
or undo all of it, and both are wrong.

**Ref.** fix/pi-gr-link-shape, 2026-09-09.
