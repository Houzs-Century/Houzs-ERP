## A sofa purchase line lost its category on the SO to PO hop, and every sofa tool keyed on it goes blind [high]

<!-- area: Sofa, fabric, variants -->
<!-- status: open -->

**Symptom.** `repair-collapsed-sofa-po-line.mjs` shipped to fix `docs/bugs/0715`
and its first production plan found **nothing**. Run
[`34218313451`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34218313451),
company 1:

```
33 hard-bound sales line(s) on 16 sales order(s) carry no dedicated
purchase line while the BOOK records one.
...
    PROVABLE - every gate passed                           0
```

Zero, over a population every one of whose documents the same run had just named.

**Root cause (traced).** The doc-scoped rerun on the one document the owner is
waiting for — run
[`34218446892`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34218446892),
`DOC=HC-PO-009435` — puts both of that purchase order's rows in one bucket:

```
    the purchase row is not a sofa                         2
```

Two rows on a two-line purchase order: **the sofa AND its pillows.** So it is not
a mis-categorised sofa, it is the whole document — `scm.purchase_order_items
.item_group` did not survive the SO -> PO hop on this population. That is the
class `docs/bugs/0514-the-so-to-po-hop-lost-the-category-so-received-sofa-stock-wa.md`
is named after, observed again, on live rows.

**What it costs beyond one gate.** `item_group` is not decoration on a purchase
line. `computeVariantKey(item_group, variants)` composes a sofa's fabric / seat /
leg into the variant key **only** for a `sofa` or `bedframe` group
(`docs/modules/purchase-order.md`), so a row that lost its category also stops
matching the sofa stock buckets it is supposed to match.

And it is why the existing re-decode tool is blind to the same rows for a second,
independent reason. `redecode-collapsed-sofa-lines.mjs` builds its corpus as

```sql
SELECT ... FROM scm.purchase_order_items i JOIN scm.purchase_orders p ...
 WHERE p.company_id = ${CO} AND i.item_group = 'sofa'
```

on both sides. `docs/bugs/0715` records that it also needs the `SOFA UNPARSED`
remark; this entry is the second lock on the same door. Either one alone hides
the population.

**Fix.** In `repair-collapsed-sofa-po-line.mjs`, what makes the line a sofa is
now the **SALES** side — the sales rows the book's own edge names, which are
`item_group = 'sofa'` and carry sofa piece codes — plus the piece codes on the
purchase row itself. The purchase row's own category is no longer consulted as a
gate.

**The category itself is REPORTED and deliberately NOT repaired here.** Writing
`item_group` moves `computeVariantKey` and with it which stock bucket the row
matches, which is a stock decision and not a link repair. Every planned build now
prints the purchase row's `item_group` and, when it is not `sofa`, says on the
same line that the category did not survive the hop and cites `0514`. The
population-wide category repair belongs to the 0514 lane.

**Ref.** `fix/do-blocked-by-po-link`, PR #3261, 2026-09-08. Sibling entry:
`docs/bugs/0715-a-sofa-the-warehouse-already-holds-cannot-be-delivered-becau.md`.

Module guide: `docs/modules/purchase-order.md`, *A sofa's purchase line and its
sales compartments*.
