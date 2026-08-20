## An empty-variant PO counted as supply for a specific-variant sales-order line [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** A bedframe SO line for a specific fabric/gap/divan/leg read as
covered by a purchase order for an unspecified bedframe, so the shortage that
should have driven a purchase was hidden and PO Outstanding showed units that
row was never going to receive.

**Root cause (traced).** routes/mrp.ts buckets demand and supply by
`composite(warehouse, code, variantKeyOf(group, variants))`, but section 7 (and
its section 8 sofa twin, added by audit D2) folded the same-warehouse
EMPTY-variant `''` PO pool into a specific-variant bucket whenever that bucket
had no PO of its own:

```js
const legacyKey = composite(whId, code, '');
const useLegacy = bucket.vkey !== '' && legacyKey !== k && ownPo.length === 0;
```

Stock never had such a fallback (`stockByKey.get(k)`, exact key), so the engine
disagreed with itself about what counts as the same thing.

**Fix.** Both fallbacks removed — supply matches demand on the full bucket key,
the way stock already did. Owner ruled it twice, verbatim: 「variant 不一样的话
应该不能拿来给那个SO 用不是吗?」 and 「我们要求不是全部variant 全部spec都相同才是一样的
东西?」 Mattress is unaffected (`ATTRS_BY_GROUP.mattress` is `[]`, so its key is
`''` either way and it was never eligible). A NULL `item_group` still keys to
`''` even when the line carries a real fabric, because `ATTRS_BY_GROUP[group] ?? []`
yields no attributes — that is deliberately left alone rather than re-derived from
the product master: stock's key is the STORED `inventory_balances.variant_key`,
which MRP cannot re-derive, so deriving on the other two sides would move demand
and supply off the stock they must match. Null-group lines stay mis-grouped
IDENTICALLY on all three sides, which is what keeps the arithmetic consistent.

**Not measured, stated plainly.** The read-only probe written for exactly this
(`backend/scripts/probe-mrp-legacy-variant-fallback.mjs`) could not be run against
prod: `workflow_dispatch` requires the workflow file on the DEFAULT branch, and
PR #2274 which adds `.github/workflows/probe-mrp-legacy-variant-fallback.yml` is
still open. So the number of rows that flip covered → shortage is UNKNOWN. Merge
#2274 and run it before believing any figure about this change.

**Ref.** fix/mrp-paging-and-strict-variants, 2026-08-16.
