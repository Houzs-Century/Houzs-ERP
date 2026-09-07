## The PO Desc2 preserver selected a doc_no column the purchase_orders table does not have [low]

**Symptom.** The first dispatch of the new PO tool
(`preserve-autocount-desc2-in-po-notes.yml`, run
[`34136259113`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34136259113),
2026-09-07 23:03 MYT, `mode=plan`) exited 1 four seconds in:

```
##[notice]mode=PLAN (everything rolls back) company=1 shape=overwrite
##[error]column h.doc_no does not exist
```

**Root cause (traced).** The script was written as a twin of the SALES-side
`preserve-autocount-desc2-in-remark.mjs`, and the header join was copied with
it. On the sales side the header is `scm.mfg_sales_orders`, whose document
number IS `doc_no` — and the ITEM table carries `doc_no` too, which is what the
sales query joins on. On the purchase side neither is true: the header is
`scm.purchase_orders`, its document number column is **`po_number`**
(`HEADER_COLS`, `backend/src/scm/routes/mfg-purchase-orders.ts:352`), and the
item table joins by `purchase_order_id`, not by a document number at all.

The join predicate itself (`h.id = i.purchase_order_id`) was already right —
matching `PO_ITEM_COLS`' own `.eq('purchase_order_id', …)` in
`backend/src/scm/lib/autocount-outbox.ts:672`. Only the SELECT and ORDER BY
carried the sales-side column name.

**Why nothing was at risk.** This is what plan-by-default is for. The failure
happened on the first `SELECT`, before any `UPDATE` was composed and long
before the transaction that would have held them — so the run wrote nothing,
and there was nothing to roll back. `mode=apply` could not have got further:
the same statement runs first in both modes.

**Fix.** `SELECT i.id, h.po_number AS doc_no, …` and `ORDER BY h.po_number`. The
alias is kept so the reporting code below it — which prints `p.doc_no` on every
sample and every discarded value — reads the same on both twins.

**The lesson worth keeping:** a twin script inherits its sibling's SCHEMA
assumptions along with its shape, and those are exactly the part that does not
transfer. `notes` vs `remark` was noticed because the owner's request named the
field; `po_number` vs `doc_no` was not, because nothing in the task mentioned
it. When copying a script across two tables, diff the COLUMN LIST against the
route's own `HEADER_COLS` / `ITEM_COLS` before the first dispatch.

**Ref.** `fix/po-notes-po-number`, 2026-09-07. Introduced by
`docs/bugs/0668-*` (PR #3082) the same day.
