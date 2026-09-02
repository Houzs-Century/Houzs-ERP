<!-- area: AutoCount sync + write-back -->
## Match up lines crashed: the sales-order header was asked for an id column it does not have [high]

**Symptom.** HC-SO-013394 sat HELD BACK with "The ERP cannot tell which lines
AutoCount already has". That screen tells the operator what to do — *"The lines
have to be matched up against AutoCount, and then the document saved again"* —
and gives them a **Match up lines** button. The owner pressed it, 2026-09-02,
and got:

> Nothing was matched — the request never got through.
> `column mfg_sales_orders.id does not exist`

So the document was stuck, the remedy the screen named was the right one, and the
button implementing it could not run at all. Every sales order in this state was
unrecoverable through the UI.

**Root cause (traced).** `scm/routes/autocount-relink.ts` read the header with one
literal column list, `.select('id, linked_ac_docno')`, for both document types.
The two headers are not shaped alike: `scm.purchase_orders` is keyed by a uuid
`id` that its lines carry in `purchase_order_id`, and **`scm.mfg_sales_orders`
has no `id` column at all** — its lines carry `doc_no`. PostgREST refuses the
WHOLE read when one selected column is absent, so the failure is total rather
than a missing field, and it lands as a 500 the operator reads as "the request
never got through".

`id` was never needed on the sales-order path: `parentValue` uses it only for
purchase orders. The list was written for the table that needs it and pointed at
both.

Proven by the production error text above, and independently by
`probe-doc-link-matrix.mjs` — which discovers its columns from
`information_schema` and ran green against production the same morning —
declaring the sales-order header key as `doc_no`.

**Fix.** `headerCols` moves into the per-document `DOC` spec beside the other
per-document facts, so each table is asked only for what it has. The same root
one line further down is closed with it: `parentValue` decided whether to use
`header.id` by testing a column NAME (`spec.parentCol === 'purchase_order_id'`),
which silently takes the wrong branch the moment a third document type is added,
with nothing failing to compile — it now reads `spec.parentFrom`.
CLAUDE.md: a parameter that DECIDES is required, never inferred.

`backend/tests/relinkHeaderColumns.test.ts` pins both, plus that every entry
carries every per-document field so adding a third cannot half-land. **Proved
RED on the unfixed tree: all 5 tests fail** (`git stash`, run, `git stash pop`),
and pass on the fix.

**UNTESTED against the live account book at the time of writing** — the button
needs the office host reachable to read the document, so pressing it on
HC-SO-013394 is the remaining verification and belongs to whoever has the host.
What is proven here is that the request now reaches the book instead of dying on
our own read.

**Ref.** fix/relink-header-no-id, 2026-09-02.
