## SKU Master opened with a remembered column filter, hiding SKUs and the row just renamed [high]

<!-- area: Products + SKU master -->

**Symptom.** Owner, 2026-09-15:
「我现在一点进去它就会带 filter，导致我以为自己的东西怎么少了那么多…每一次打开应该默认都是全部展开的。」

After he pressed Save on a renamed description, the grid showed "0 rows" with the
DESCRIPTION funnel lit.

**Root cause (traced).** Every DataTable saves its column funnels in localStorage
as a remembered view (owner 2026-07-29): `dt:filters:<table>` in
`frontend/src/components/DataTable.tsx:811` (merge base `404c434b5`).

The SKU grid's key is `products-sku-default`. Every category tab except Sofa and
Mattress shares it (`gridTableId` in Products.tsx). So a Description funnel ticked
once on any of those tabs came back on every visit.

A funnel is a fixed list of VALUES. Renaming a SKU changes its description to a
value the saved list does not hold. When Save closed edit mode and the grid
mounted again, that filter hid the renamed row. When it was the only ticked value,
it hid every row.

**Fix.**

- **New DataTable option.** `persistFilters={false}` keeps funnels for the
  current visit only and erases any filter saved for that table under the
  company-scoped key and the old unscoped one. The erase re-runs when the stored
  hook re-reads after the company resolves.
- **SKU Master uses it.** The grid mounts again after Save, so a funnel never
  outlives an edit.
- **Other tables are unchanged.** Every other table keeps the saved-view
  behaviour.

Pinned in `frontend/src/components/DataTable.test.tsx`
("persistFilters={false} filters for this visit only and erases a saved
filter"). On the unfixed DataTable it fails: a saved filter showed 3 of 6 rows.
It passes after the fix, and the DataTable, company-key, layout-sync and
columns-drawer suites stay green.

Observed in a local browser harness with the owner's shape of sticky filter
seeded (`desc: ['BACK CUSHION 04']`). The page opened showing 3 of 3 SKUs, and
`dt:filters:*` was empty afterwards.

**Ref.** fix/sku-master-edit-filter-category, 2026-09-15.
