## The sofa census assumed four line tables were shaped alike and died on the purchase order [high]

**Symptom.** `check-sofa-code-vs-description` against production (run
34462427810) printed its product-master section and its sales-order section, then
stopped:

```
PostgresError: column i.cancelled does not exist   (42703)
```

`scm.purchase_order_items` has no `cancelled` column. 42703 fails the WHOLE
statement, so the PURCHASE ORDER and DELIVERY ORDER sections produced **nothing
at all** — and the purchase order is the one the factory reads, which is the
half the owner asked for.

**Root cause (traced).** The script held one `SPECS` list of four line tables and
built one query shape for all of them:

```js
AND coalesce(i.cancelled, false) = false
```

`mfg_sales_order_items` and `delivery_order_items` carry `cancelled`;
`purchase_order_items` does not, and `grn_items` carries neither `cancelled` nor
`item_group`. The four tables were assumed to be the same shape because three of
them nearly are.

**What made it worse than a crash.** The run exited 1 AFTER printing two clean
sections. Read quickly, it looks like a report with a stack trace at the bottom —
the missing sections do not announce themselves. This is CLAUDE.md's *check that
is not running*, in its most confusing form: a partial verdict that reads like a
whole one.

**Fix.** Each table's columns are asked of `information_schema` before the query
is built. Where `item_group` is absent the sofa predicate falls back to the CODE
shape — a compartment code carries its hand — which is WIDER than `item_group`,
never narrower, so nothing is silently dropped, and the run SAYS which predicate
it used for that table.

**Goods receipts were added in the same change**, at the owner's instruction
(「包过我的GR」). The receipt is the link between the purchase order and the
stock lot, so a wrong code there is a wrong code on the STOCK, not only on paper.

**What the partial run did establish, which is worth keeping.** It refuted the
hypothesis the whole investigation was built on:

| | |
|---|---|
| product master, sofa SKUs stating a hand | **372** |
| name contradicts code | **0** — the master is CLEAN |
| sales-order sofa lines | 1,329 |
| hand disagrees | **2**, both on HC-SO-012016 |

The owner had been told the product master was the likely root. It is not. The
two lines are the ones he found by eye, which is consistent with the amendment
path writing `item_code` without `description` (`so-revision.ts:694`) and not
with anything systemic.

**Ref.** fix/sofa-code-desc-po-gr, 2026-09-10.
