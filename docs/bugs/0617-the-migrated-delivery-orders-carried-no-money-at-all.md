## The migrated delivery orders carried no money at all [high]

<!-- area: Cutover + migrated data -->

**Symptom.** The owner, 2026-09-02, on the company-1 Delivery Orders list: every
one of the 71 rows shows **AMOUNT RM 0.00**, and the **REVENUE** tile above the
list reads **RM 0.00** with it — over delivery orders whose sales orders carry
real money.

**Root cause (traced).** `backend/scripts/create-migrated-documents.mjs`
`doDos()` inserted `scm.delivery_order_items` naming ten columns and **none of
the price ones**:

```
(delivery_order_id, so_item_id, item_code, description, uom, qty, company_id,
 item_group, variants, description2)
```

`unit_price_sen` and `line_total_sen` are `integer DEFAULT 0 NOT NULL`
(`scm-schema/2990s-full-schema.sql`), so the omission cannot fail — it defaults.
The header total is `Σ line_total_sen` (`delivery-orders-mfg.ts:461`), and the
list's Amount column and its Revenue tile both read that one column.

**`doGrns()` in the SAME FILE always wrote them** — `unit_price_sen`,
`line_total_sen`, computed the same way. One file, two answers, and the file
already carries a comment about a previous instance of exactly this
(`:190` — *"The GRN writer above always copied them, which is exactly why nobody
noticed. Do not drop them again."*, about `variants` / `description2`). Same
class, same file, second time.

**Established as a DEFECT and not an owner decision, before anything was
changed** — the cutover deliberately imported no history, no invoices and no
stock movement, so "the migrated documents are deliberately thin" was the
competing explanation and had to be ruled out:

1. **No ruling covers it.** Both `docs/autocount-cutover-ledger.md` §9 (the six
   owner decisions) and `docs/ac-reimport-2026-08-28-ledger.md` were searched for
   any decision about delivery-order amounts. There is none.
2. **A policy would not apply to half a file.** The GRN half writes prices.
3. **The price is LOAD-BEARING, not display.** `do-line-remaining.ts:326` reads
   `delivery_order_items.unit_price_sen` into the deliverable descriptor, and
   `pages/scm-v2/SalesInvoiceFromDo.tsx:321` puts it straight into the New Sales
   Invoice prefill.
4. **Nothing would have caught it.** The SI price-drift warning skips a zero by
   design — *"An agreed price of 0 has no ratio to drift from"*
   (`sales-invoices.ts:512`) — and `migrated_no_stock` gates the sales invoice
   (`post-si-revenue.ts:49`) and the purchase invoice
   (`purchase-invoices.ts:301`) but **not** the DO → SI path.

So an operator raising an invoice from one of these delivery orders was
prefilled **RM 0.00 per line, silently.**

**Fix, in two halves.**

*The writer*, so it cannot recur: `doDos()` now selects
`unit_price_sen / discount_sen / unit_cost_sen` off the SO line — the same row
the interactive create path reads through `soDeliverableRemaining`
(`delivery-orders-mfg.ts:4058`) — carries them onto the plan item, writes them,
and sets the header `local_total_sen` to the sum.

*The data*: `backend/scripts/repair-migrated-do-prices.mjs` +
`.github/workflows/repair-migrated-do-prices.yml`. Plan by default; apply needs
`CONFIRM="THE PRICE COMES FROM THE SALES ORDER"` and then verifies the SHAPE on
a **fresh connection** — no repaired line still zero, none negative, every
touched header equal to the sum of its own lines. Passes
`audit:release-discipline` with no new violations.

**The discount is deliberately NOT carried, on both halves.**
`mfg_sales_order_items.discount_sen` is a LINE amount, not a per-unit one, and
one migrated SO line is routinely split across several AutoCount delivery notes
— that is what the script's own `taken`/`used` counters are for. Copying it
whole onto each split would deduct it once per delivery; dividing it needs a
rule nobody has written. A per-UNIT price is well defined; the discount stays 0
and the figure is honestly undiscounted. This is stated rather than quietly
decided.

**Scope kept to the defect.** Only lines that are `line_total_sen = 0` AND on a
`migrated_no_stock` delivery order AND whose linked SO line has a price > 0. A
genuinely free line is left alone (its SO line is 0 too). A line with **no**
`so_item_id` is reported and never guessed at.

The category buckets, cost and margin are left to `recomputeDoTotals`, which is
that rule's one home — a second copy inside a repair script is how two answers
start.

**UNTESTED against production, and UNDISPATCHED.** Neither the repair nor its
workflow has been run; a `workflow_dispatch` workflow is not shipped until it has
been dispatched once and reported success. Run it with `mode=plan` first — the
plan names every document and line it would touch, and reports the two
left-alone buckets.

**Ref.** `fix/system-self-contradiction`, 2026-09-02.
