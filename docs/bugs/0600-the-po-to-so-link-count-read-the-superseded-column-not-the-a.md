<!-- area: Purchase orders + GRN + PI -->
## The PO-to-SO link count read the superseded column, not the allocations [low]

**Symptom.** `probe-doc-link-matrix.mjs` reported the PO -> SO edge at
1005 / 1301 lines and the remaining 296 were carried in the handoff as
"unverified whether the other 296 are legitimate stock-buys". A reader is left
believing roughly a quarter of purchase lines have lost their customer.

**Root cause (traced).** The matrix counts `NOT NULL` on
`scm.purchase_order_items.so_item_id`, and for a consolidated line that column
is not the answer. Mig `0235_scm_po_item_allocations.sql` states it twice — in
its header ("purchase_order_items.so_item_id is single-valued, so NO correct
value exists for such a line") and in the table's own `COMMENT`: when
allocations exist they "SUPERSEDE the line's own so_item_id", and an allocation
carrying `so_item_id IS NULL` means "for stock", stated deliberately rather than
missing. So the probe reported a correctly-attributed consolidated line as
unlinked, and an explicit stock buy as a gap.

This is the same shape as `0599` and as the memory note *"a grep of one file
answers a question about that file"*: the count was taken from the column the
fast path uses instead of from the module that owns the rule. `po-so-coverage`
layer (b) reads the allocations FIRST and the column only as a fallback — the
probe read the fallback and called it the population.

**Fix.** `backend/scripts/probe-po-so-link-provenance.mjs` (read-only) resolves
the link the way layer (b) does and classifies every line with no `so_item_id`
into `ALLOCATED-TO-SO` / `ALLOCATED-STOCK` / `STOCK-BUY` / `UNATTRIBUTED`, so
the residue is the only thing left to read. It PRE-FLIGHTS its own tables and
`exit 3`s rather than printing a clean-looking zero (the `0599` guard), and it
prints what `so_item_id` alone would have said, beside the real answer, so the
undercount cannot be re-derived from this repo again.

The matrix probe itself is left alone deliberately: it is a structural
inventory of which COLUMNS carry links, and adding one pair's business rule to
it would make it a different kind of artifact.

**UNTESTED against production at the time of writing** — the workflow
`Why a PO line has no SO link (read-only)` exists and has not yet been
dispatched. The counts above (1005/1301) are the matrix's, already observed.

**Ref.** probe/po-so-link-provenance, 2026-09-02.
