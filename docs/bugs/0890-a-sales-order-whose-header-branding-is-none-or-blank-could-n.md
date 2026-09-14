## A sales order whose header branding is NONE or blank could not be found by the Branding filter [medium]

**Symptom.** Owner 2026-09-14: 「没有品牌的，你可以补到品牌吗？」. The SO list shows a
brand on every order, but the new Branding filter (PR #3830) and the free-text
search read the HEADER `branding` column, so an order whose header says `NONE` or
is blank cannot be found under the brand the screen shows it with. Production,
read-only plan run 34830280390 (2026-09-14): company HOUZS 177 of 2,957 orders
(`NONE` x169, NULL x8); company 2990 6 of 175 (NULL x6).

**Root cause (traced).** Two sources, measured by that same plan run:

1. **169 `NONE` + 3 NULL on Houzs are imported AutoCount orders.** Their
   `linked_ac_docno` is an AutoCount number (e.g. `SO-013099`); the importer
   copies AutoCount's `UDF_BRANDING` as-is (copy-never-compute), and the floor
   types `NONE` there. `NONE` is itself a row in Houzs's `project_brands`. No
   scheduled workflow runs the importers; `sync-ac-delta`'s `hdr` lane (off by
   default) is the only tool that would copy the book's value again.
2. **ERP-created orders were stamped from the SKU only.** At create,
   `deriveHeaderBrandingFromLines` (`backend/src/scm/lib/derive-line-branding.ts`)
   took the representative line's `mfg_products.branding` and returned null when
   it was blank — while the list's label rule prints the company's house sofa
   brand for every sofa. The Houzs `8211-*` sofa SKUs carry no branding, so
   HC-SO-2609-065 (2026-09-13), -071 and -072 (2026-09-14) were created with a
   NULL header and show ZANOTTI in the list. STILL LIVE until this PR deploys.
   The 6 NULL 2990 orders are June/July orders whose SKUs do carry a brand; they
   predate the 2026-08-18 create stamp. HC-SO-2609-019 / -062 and
   2990-SO-2607-015 are accessory-only orders whose list label ("Accessory") is
   not a brand, so they are correctly left blank.

**Fix.**
- `deriveHeaderBrandingFromLines` now takes a required `listFallback`
  (company code + the company's active `project_brands`): when the SKU says
  nothing it stamps the list's own label, but only if that label is a
  maintained brand (`brandForHeader`: exact, or case-insensitive written in the
  brand list's spelling). Test `backend/src/scm/lib/derive-line-branding.test.ts`
  was RED on the unfixed tree (3 failed: ZANOTTI, 2990s Sofa, BEDFRAME came back
  null).
- The list handler's `first_item_category` / `first_item_branding` rule was
  lifted, unchanged, into `backend/src/scm/lib/so-list-first-item-branding.ts`;
  `so-list-first-item-branding.test.ts` compares it against the old inline code
  over 3,000 generated orders (and goes red on a one-line mutation).
- `backend/scripts/backfill-so-header-branding.mjs` + workflow **Backfill SO
  header branding (plan / apply)** fill the existing headers with exactly what
  the list shows, importing those functions. Plan on production: HOUZS fill 160,
  17 not derivable; 2990 fill 5, 1 not derivable.

**Ref.** fix/so-branding-backfill, 2026-09-14.
