## A purchase order line written with the wrong category or no link hid the order from MRP [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-09-15: 「我们明明已经开了 PO，可是它又显示着 shortage」 and
「SI、SO 跟 source PO 等等，都是要对应解决掉的」. A company-1 sofa, bedframe or Sofa
Accessory sales line reads SHORT on the MRP page while its own purchase order is
open, so the buyer is told to order it again.

**Root cause (traced).** Such a line is covered only by a purchase line whose
`so_item_id` names it. Production was clean on the canonical check the same day
(run 34943306926: 0 short-with-own-PO over 3,899 lines); a read of every write
path found five doors that could still produce the defect:

1. **MRP read the PO line's category, the allocator reads the sales line's.**
   `isDedicated` in `scm/routes/mrp.ts` required the PO line itself to be on a
   bound group; `so-stock-allocation.ts` binds by the SALES line's group and never
   looks at the PO's. A link whose two lines disagree went SHORT either way: a
   bound PO on an unbound sales line was withheld from the pool that line reads,
   and an unbound PO on a bound line sat in a pool it never reads. **PROVEN live**
   (probe run 34944608976, read-only): `HC-PO-010086` SQUARE PILLOW
   `fabric_accessory` linked to `HC-SO-013346` `accessory`, IN_PRODUCTION, nothing
   received — the pillows changed category on 2026-09-14 and that sales line kept
   the old group.
2. **PO amendment ADD** (`lib/po-revision.ts`) stored `new_variants.itemGroup` or
   `others` with no SKU lookup, and a SPEC-moved item code kept the old group.
3. **Line PATCH** wrote `itemGroup` exactly as sent, and `soLinkTargetRefusal`
   checked item code only, so a link could join a sofa PO line to an `others`
   sales line; the PATCH also let a bound line be unlinked, leaving it counted
   for no order.
4. **Allocation splits** (mig 0235) are read by neither MRP nor the allocator, so
   a bound line split across sales lines covers one of them at most. Prod has
   **0 allocation rows in total** (same probe), and the desktop Split button can
   reach a bound line.
5. **`repair-mrp-po-line-links.mjs`** planned `in ('sofa','bedframe')` only, a day
   after Sofa Accessory joined the rule, and its `(SP)` regex sat in a postgres.js
   tagged template, where `\(` and `\s` lose their backslash (postgres.js builds
   the query from the cooked strings, `src/types.js:100`), so it matched no
   mattress.

**Fix.**
- `mrp.ts`: a link is dedicated when EITHER side is bound, and an unbound line reads
  its own dedicated queue before the pool. Tests `mrp.test.ts` "a BOUND PO line
  linked to an UNBOUND sales line covers that line" and the reverse — RED on the
  unfixed engine (`expected null to be 'PO-PILLOW'`, `'PO-OTHERS'`), GREEN after.
- `po-revision.ts`: ADD and SPEC resolve the group from the SKU
  (`skuCategoryResolver` / `lineIdentityFields`, the create path's rule), and a
  sales-order follow-up amendment is refused (it applies through `reviseBoundPo`,
  which links each added line — the route already branched). 3 new tests RED on the
  old engine (`expected 'others' to be 'fabric_accessory'`, `'sofa'`, "resolved
  instead of rejecting").
- `lib/hard-bound-po-line.ts` + `mfg-purchase-orders.ts`: add-line, create, line
  PATCH and allocation targets refuse a cross-category link when either side is
  bound (409 `so_link_category_mismatch`); the PATCH stores the SKU's group;
  clearing the link on a company-1 bound line is refused (409
  `hard_bound_unlink_refused`); allocation create/edit on a company-1 bound line is
  refused (409 `hard_bound_line_not_splittable`, delete stays allowed).
  `routes/mfgPoHardBoundLink.test.ts`, 6 tests, all RED on the unfixed route.
  Sized before shipping (same probe): of 14,475 + 413 open sales lines and 554 +
  61 open PO lines (company 1 + 2), 0 carry a group that differs from their SKU's
  where either is bound, so the refusal blocks nothing on today's data except a
  re-link of the one row above.
- `scripts/lib/hard-bound-group.mjs` mirrors `isHardBoundLine` (referee
  `tests/hardBoundGroupMirror.test.ts`, which runs both over the same inputs) and
  plans class B in JS; the repair script uses it. RED with the old two-group list:
  5 of 17 fail.

**Not changed:** existing rows (`HC-PO-010086` is reported, not repaired); the
convert paths (they already resolve the group from the SKU, and the engine change
covers a stale sales line). Once a shape-1 purchase line like `HC-PO-010086` is
RECEIVED, its goods are filed under the PO's stock key, which differs from the
sales line's, so both engines will read that line short until the sales line's
category is corrected (LIKELY, read from the code, not observed) — the fix for
that is the category data run, not this code.

**Ref.** fix/hard-bound-po-link-at-source, 2026-09-15.
