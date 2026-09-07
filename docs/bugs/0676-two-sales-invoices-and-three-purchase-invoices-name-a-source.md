## Two sales invoices and three purchase invoices name a source line for a different product [high]

**Symptom.** Nobody saw it, and that is the finding. Five invoice lines in
production carry a link to the delivery or receipt line they were raised from,
and that line is for a DIFFERENT PRODUCT. Every one of the five is FILLED and
none DANGLES — the foreign key resolves to a real row — so no constraint fires,
no coverage count drops, and `probe-doc-link-matrix.mjs`, which counts each link
filled and dangling, reports both chains clean. It is an instance of
`docs/bugs/0672-bug-class-key-without-identity-a-link-written-on-the-key-alo.md`:
a link written on the strength of a KEY without asserting that the two sides are
the same thing.

**PROVEN, by `backend/scripts/probe-link-identity.mjs` against
`secrets.DATABASE_URL`** — runs **34137796488** (2026-09-07 23:22 local) and
**34139187692** (23:37 local), both concluded `success`:

| link | linked / total rows | carries no link | dangling | **wrong product** |
|---|---|---|---|---|
| `sales_invoice_items.do_item_id` | 182 / 182 | 0 | 0 | **2**, on 2 documents |
| `purchase_invoice_items.grn_item_id` | 198 / 198 | 0 | 0 | **3**, on 3 documents |

**None of the five is a perfect permutation of its own document's codes**, so
these are not positional swaps between two lines of one invoice: the parent is a
product the document does not even order.

**What it costs, and it is not the invoice's face value.** The invoice line
carries its own quantity and price, so the amount printed for the customer or
owed to the supplier is untouched by the link. What the link decides is
downstream:

- `sales_invoice_items.do_item_id` is the `invoiced` term in
  `remaining = delivered - invoiced - returned` (`backend/src/scm/lib/do-line-remaining.ts`),
  which is the cap EVERY delivery-order-to-sales-invoice write path is checked
  against — `backend/src/db/migrations-pg/0303_scm_si_items_do_item_id.sql` calls
  it "the column a MONEY CEILING rests on" in its own header. A wrong link spends
  one delivery line's remaining allowance on a different product's line: the line
  it points at reads over-invoiced and can no longer be billed, and the line it
  should have pointed at reads never-invoiced and can be billed a second time.
- `purchase_invoice_items.grn_item_id` is how a supplier invoice's money reaches
  the LOT it paid for. `backend/src/scm/lib/recost.ts` aggregates purchase-invoice
  lines BY `grn_item_id` and re-costs that receipt, and `grn_items.invoiced_qty`
  is a stored counter on the same key. A wrong link books one receipt's cost onto
  another receipt's stock, which moves inventory valuation and COGS.

**Root cause — UNKNOWN at the time of writing, and deliberately not guessed.**
`docs/bugs/0672` enumerates the write sites and lists both invoice chains under
site 15: `routes/sales-invoices.ts:392`, `routes/purchase-invoices.ts:833/:2059`
take the source line id from the CLIENT and check company, parent status and a
quantity cap — never the item. That is a live route through which these rows
COULD have been written, but no evidence yet ties these particular five to it
rather than to a cutover importer. Naming it as the cause before the rows are
read would be the guess CLAUDE.md forbids.

**The instrument.** `backend/scripts/probe-link-identity.mjs` COUNTS. A count
cannot be repaired: nobody can say which invoice, which source document, which
lines, what the two sides say, or whether a correct parent even exists to
re-point to. `backend/scripts/probe-invoice-link-facts.mjs` (this PR, read-only)
answers exactly that, and prints for each wrong link every line of the parent
document and of the document the invoice HEADER names, with the claim each
already carries — so a repair can be shown to be FORCED rather than chosen.

**Fix.** NOT IN THIS ENTRY YET. This PR ships the instrument and changes no row.
**UNTESTED as a remedy:** the workflow has not been dispatched — it cannot be
until it is on `main`, because `workflow_dispatch` only exposes workflows from
the default branch. Nothing here repairs anything, and no claim is made about
what a run will say.

**Ref.** probe/invoice-link-facts, PR #3120, 2026-09-08.
