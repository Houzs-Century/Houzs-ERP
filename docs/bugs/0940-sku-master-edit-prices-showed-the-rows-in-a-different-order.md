## SKU Master Edit Prices showed the rows in a different order and set than the grid the operator was looking at [medium]

<!-- area: Frontend + mobile -->

**Symptom.** Owner, 2026-09-15:
「很奇怪，我看到的 front end UI 明明顺着排，结果点 edit 了，顺序直接不一样。…我看到的东西，我要去 edit 的时候，突然它位置不见了。」

He had SKU Master sorted by Description. When he pressed Edit Prices, the rows
came back in a different order, and the row he was looking at had moved.

**Root cause (traced).** SKU Master has two tables, not one:

- **View mode.** The shared `DataTable`. It sorts and funnels the rows itself, in
  the browser.
- **Edit Prices mode.** A separate hand-built table that renders `rows`, the array
  as the server returned it (`frontend/src/pages/scm-v2/Products.tsx:1030` at
  merge base `31352ebe3`).

The switch happens at `Products.tsx:940` (`{!editMode && (`). The grid was
unmounted, so its sort and its funnels had no way to reach the editor. This split
has existed since the table moved onto DataTable (#1381, 2026-07-28).

It also lost the funnels on the way back. The grid keeps funnels for the visit
only (`persistFilters={false}`, 0917), so Cancel remounted it with no filter. A
filtered view came back unfiltered even though nothing had changed.

**Fix.**

- **The grid stays mounted.** In edit mode it is hidden, not removed, so its sort
  and funnels stay live.
- **It reports what it shows.** `onFilteredRowsChange` passes its rows up.
- **The editor uses that order.** It renders those rows via `rowsInGridOrder`
  (`products/SkuEditRow.tsx`), using the latest copy of each row. Select-all,
  virtual scrolling and the record count all follow the same list.
- **Cancel** returns to exactly the view he left.
- **A successful Save** remounts the grid with no funnels. This keeps 0917 true:
  a funnel is a list of values, so a description renamed under it would
  otherwise vanish. The saved sort stays.

Pinned in `frontend/src/pages/scm-v2/products/skuEditKeepsViewOrder.test.tsx`,
which renders the real `Products` page:

- Description sort, then Edit: on the unfixed tree the order was `A,B,C` against
  the expected `C,B,A`.
- Funnel on one value, then Edit: the unfixed tree showed all 3 rows instead of 1.
- Save under a funnel: without the remount, the row count was 1, not 3.

All three were RED before the fix and GREEN after.

Observed in Chromium through a local Vite harness that rendered the real page
with stubbed data (8 SKUs):

- Server order: `ACC-001…008`.
- After a Description sort: `003,005,007,008,004,006,002,001`.
- After Edit Prices: the same `003,005,007,008,004,006,002,001`.

**Ref.** fix/edit-order-and-mrp-colours, 2026-09-15.
