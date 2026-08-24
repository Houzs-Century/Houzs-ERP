## The Purchase Order list printed the warehouse NAME where the house rule says CODE [medium]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 采购单列表的「Purchase Location」那一栏印的是仓库全名，栏位塞不下就被
切成「BALAKONG WAREHO…」，看不出是哪个仓。同一页按「列印 PO」出来的 PDF 印的却
是仓库代号。一个页面，同一个仓库，两个答案。原因不是那一行写错：整套系统只有
**后端**有「先代号、后名字」这条规则，前端根本 import 不到后端的档案，所以每一个
要显示仓库的前端画面都自己手写一遍，久了就各写各的。这次把那条规则原封不动复制
一份到前端，并且加一个测试盯着两份档案必须一模一样。

**Symptom.** Owner, 2026-08-21, on `/scm/purchase-orders`: the Purchase Location
column reads `BALAKONG WAREHO…` — a truncated full name — instead of the short
warehouse code every other document shows.

**Root cause (traced).** `frontend/src/pages/scm-v2/PurchaseOrdersListV2.tsx`'s
`locationOf` was `r.purchase_location?.name || r.purchase_location?.code || ""`
— NAME first. The house rule is the opposite and is written down twice:
`backend/src/scm/lib/warehouse-label.ts` (`warehouseLabel`, code-first-then-name)
and `docs/modules/warehouses.md` ("its one display rule is `warehouse-label.ts`
(code first, then name)"). The SAME FILE already disagreed with itself — its PDF
export path sets `purchase_location_name: wh.code`.

That one line is the symptom, not the cause. `warehouseLabel` existed ONLY under
`backend/src`, and the frontend cannot import from there, so every frontend
surface that shows a warehouse hand-wrote its own order. Counted off the diff of
this branch (`git diff origin/main -- frontend/src`, removed lines carrying a
`||` / `??` fallback): **19 hand-written warehouse labels across 12 files**,
disagreeing in both directions —

- **9 were NAME-first**, the reported defect's own class: the PO list's
  Purchase Location, both Stock Transfer columns, the Stock Take list, three
  mobile module-list rows, the DO sales-location dropdown, and the delivery
  depot picker's vote label.
- **10 were already code-first** and therefore rendered correctly — but each
  was still a private copy of the rule, which is what makes the next one drift.

**Ruled out.** "One page, one wrong line" — refuted by the same scan; and
"the backend sends the wrong field" — refuted by the list SELECT in
`backend/src/scm/routes/mfg-purchase-orders.ts`, which embeds
`purchase_location:warehouses!purchase_location_id(id, code, name)`. Both
fields arrive; the choice was always the client's.

**Fix.** The repo's existing MIRROR pattern (`phone.ts`, `total-height.ts`,
`do-shipped-states.ts`): `frontend/src/vendor/scm/lib/warehouse-label.ts` is a
BYTE-IDENTICAL copy of the backend module, which is the path
`backend/scripts/check-shared-mirrors.mjs` already enumerates — the pair now
reports IDENTICAL there (12 IDENTICAL → 13) with no new script. Twelve frontend
files now call `warehouseLabel` instead of spelling the order themselves; `GrnFromPo.tsx`,
whose picker rows carry the warehouse as FLAT snapshot columns, reaches it
through a one-line local adapter rather than a second rule.

`frontend/src/vendor/scm/lib/warehouse-label.canonical.test.ts` is the referee:
byte-identity of the pair, the code-first order asserted on the frontend side
too (byte-identity alone would still pass if someone flipped BOTH files), and a
corpus pin that fails NAMING any file which re-grows a private `?.name || ?.code`
warehouse fallback. Proved RED on the unfixed tree by restoring the old
`locationOf` — two assertions failed and named the file.

**Two sites are deliberately left, both already code-first and therefore
rendering correctly, both recorded in that test:**

- `pages/scm-v2/SalesOrderDetail.tsx` (`hit?.warehouse?.code ?? hit?.warehouse?.name`)
  — owned by a PR running in parallel. It is the test's shrink-only `PENDING`
  entry, so converting it FAILS the corpus test until the entry is deleted.
- `pages/scm-v2/Inventory.tsx`, three cells over the flat
  `warehouse_code ?? warehouse_name` columns. It was converted and then REVERTED:
  that file sits AT its file-size ceiling and `npm run check:file-size` fails a
  change that grows such a file. Hygiene is not worth a ceiling. Recorded in the
  test's comment beside `PENDING` (the object-shaped scan cannot see a flat-column
  copy, so it cannot be listed there).

**Ref.** fix/warehouse-label-and-desc2, 2026-08-21.
