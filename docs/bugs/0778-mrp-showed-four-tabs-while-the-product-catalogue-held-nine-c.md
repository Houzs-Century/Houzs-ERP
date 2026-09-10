## MRP showed four tabs while the product catalogue held nine categories, so 181 SKUs could be planned and rendered on no tab [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The same shape as `docs/bugs/0777-mrp-dropped-8-accessory-codes-from-every-tab-because-the-row.md`,
which shipped hours earlier, and found while sweeping the system for its
siblings on the owner's instruction 「确保全系统没有这个问题了」 and 「我们要确认有
没有同一个问题：在批处理时 miss 掉 order？如果等到要送货的时候，我们才发现没有
order，那就严重了。」

In plain terms: 客人订了餐桌、床单、香薰或地毯，MRP 那一页永远看不到，采购也就永远
不会下单 —— 而画面上完全没有任何提示，跟「已经有货」长得一模一样。

0777 was a row arriving with `category: null`. This one is the other half: a
row arriving with a category that is real, catalogued and non-null — `DINING`,
`BEDLINES`, `DIFFUSER`, `CARPET` — for which the page simply had no tab. The
engine planned the line, gave it a real `qtyNeeded` and a real shortage, and it
appeared on none of the four tabs, with no empty state, no count and no warning.

**How big, measured from files committed in this repo (PROVEN, no production
query needed):**

| evidence | number |
|---|---|
| `backend/scripts/data/align-skus-houzs-century.json` — the payload `align-open-skus.mjs` INSERTS into `scm.mfg_products` for company 1 | **181 of 1,242 SKUs** (BEDLINES 85, DINING 55, DIFFUSER 39, CARPET 2) stranded |
| `backend/scripts/data/ac-outstanding-so.json.gz` — the AutoCount outstanding sales-order export | **10 open order lines / 5 item codes / 15 units** on DINING codes (`AN-TABLE TOP`, `AN-DINING LEG`, `CH-DT ROD`, `AN-DINING CHAIR`, `CH-DL ROD`) |

**Root cause (traced).** ONE taxonomy, written in two places, which had drifted
by four members — and neither side counted what fell between them.

- The catalogue side: `public.mfg_product_category` and its `scm` twin hold
  **nine** members. Five are in the baseline DDL
  (`backend/scripts/scm-schema/2990s-full-schema.sql:14`); DINING, BEDLINES,
  DIFFUSER and CARPET were added by migrations `0258`-`0261` and their scm twins
  `0262`-`0265`, "so Houzs SKUs from the AutoCount catalogue can be tagged".
  `backend/src/scm/routes/mfg-products.ts:233` lists all nine.
- The page side: `frontend/src/pages/scm-v2/Mrp.tsx` held a hand-typed
  `VIEW_CATEGORY` of **four**, plus `VIEW_TABS` of four.

Both ends of the request then dropped the other five. The page sends
`?category=<the tab>`, so `computeMrp`'s filter — `if (catFilter && cat !==
catFilter) continue;` (`backend/src/scm/routes/mrp.ts`, section 6) — removed
every DINING line from every one of the four requests, and unlike the `undated`
`continue` forty lines below it, that one is **counted nowhere**. Whatever
survived was filtered a second time by `s.category === VIEW_CATEGORY[view]`. So
the row was unreachable by two independent mechanisms.

**And the four members are not the ceiling.** Migration
`20260905T0900_acc_item_groups.sql:87-117` ships
`scm.acc_register_item_group(p_code, p_name)` — `SECURITY DEFINER`, granted to
`service_role` — which runs `ALTER TYPE ... ADD VALUE IF NOT EXISTS` on BOTH
enums at runtime. Its own header states the intent: *"the product taxonomy to be
a REGISTRY the owner can extend himself (今天 9 个品类是 enum 的 9 个值,他要能自己
加 group)"*, and *"every reader treats the enum as an open list"*. A hard-coded
tab list is a reader that does not. Every category the owner creates from now on
would have been stranded on the day he created it.

**What was checked and RULED OUT**, so nobody re-chases it:

- The readiness engine is NOT affected. `normCategory`
  (`backend/src/scm/lib/so-readiness.ts:66`) has an `OTHERS` catch-all and
  `summariseReadiness` puts a non-MAIN line in the accessory tally (`:196`), so a
  DINING line still counts toward whether an order is ready. It is a real
  partition with a catch-all; MRP's four tabs were not.
- The five SCM document lists (PO, PI, SI, GRN, DO) are already defended —
  `backend/tests/statusBucketsEnumMembership.test.mjs` asserts every enum member
  is in exactly one bucket. The Sales Order list has an `Other` catch-all tab
  (`backend/src/scm/lib/so-tab-statuses.ts`). Neither was the gap.
- Mobile is NOT affected: `frontend/src/mobile/MobileModuleList.tsx`'s MRP chips
  filter on stock state, not category, so mobile was already showing all nine.

**Fix.** The tab list is no longer typed on the page. `MrpResponse.categories`
has carried the answer since the endpoint existed — every product category in
the company's catalogue, paged and company-scoped, read in `mrp.ts` section 2
whose own comment calls it *"the tab list"* — and the page never read it. It does
now, through one module,
`frontend/src/pages/scm-v2/mrp-views.ts`: the four original tabs first, in their
original order, then every other catalogue category, SERVICE excluded because
`isServiceLine` skips service lines before the category filter and its tab could
only ever be empty. A category with no hand-written label is Title Cased and
shown rather than dropped — the same rule, for the same reason, that
`backend/src/scm/shared/so-branding-label.ts` already applies.

`mrpCategoryOf(value)` and the tab id are one declared inverse pair rather than a
second lookup table, because the page must choose `?category=` before it has a
response to derive tabs from; `mrp-views.test.ts` pins the round-trip on every
tab the enum can produce.

**Proved RED on the unfixed tree.** `frontend/src/pages/scm-v2/mrp-views.test.ts`
reads the enum out of the SQL and the SKU counts out of the committed alignment
payload — never a hand-typed list, which is the fault being tested — and failed
`3 failed | 4 passed` with:

```
mfg_product_category has DINING, BEDLINES, DIFFUSER, CARPET but the MRP page has no tab for it.
align-skus-houzs-century.json opens SKUs the MRP page can never show: BEDLINES (85 SKUs), CARPET (2 SKUs), DIFFUSER (39 SKUs), DINING (55 SKUs).
```

`frontend/src/pages/scm-v2/mrpCategoryTabs.test.tsx` renders the real page and
was proved RED the same way (`2 failed | 2 passed`): `Unable to find role="tab"
and name "Dining"`, and the tab bar reading four names where eight were expected.
Both pass on the fixed tree.

**NOT fixed here, and it needs the owner** — a row whose category is `null`
(an item not in `mfg_products` whose `item_group` maps to nothing) is still
dropped by the section-6 filter, uncounted. Making that drop LOUD means adding a
tally beside that `continue`, in the section 0777 shipped this morning; it is
listed in the PR body rather than done silently on top of a same-day deploy.

**Ref.** audit/silent-drop-sweep, 2026-09-10.
