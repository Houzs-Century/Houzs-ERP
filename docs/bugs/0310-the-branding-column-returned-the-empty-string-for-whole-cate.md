## The Branding column returned the empty string for whole categories, and the rule that filled it was applied on one page of four [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner 2026-08-17: "不可能的，如果他没有东西的话，只是 service 的话，他也
会 mention service 的不是吗？… 所以 by right 不应该会有空的 branding 的。" Sales orders
were showing a blank / em-dash Branding cell.

**Root cause, and it is two bugs wearing one coat.**

*(1) The rule could return nothing.* `deriveBranding`
(`backend/src/scm/lib/so-display-branding.ts:52`, pre-fix) mapped SOFA →
"2990 Sofa", BEDFRAME → "Bedframe", MATTRESS → the item's brand, and ended in a
bare `return ''` for everything else — ACCESSORY, SERVICE and OTHERS — plus
`if (!cat) return ''`. It also compared with `===` against normalised values
only, so raw `item_group` text (the column is free TEXT, e.g. "BEDFRAME - DIVAN")
fell out of the bottom as blank too. Measured over the category values the
system can actually produce crossed with the brand shapes a line can carry,
**180 of 234 combinations rendered blank**.

OTHERS is not a corner case. `mfg_product_category` has been extended four times
since that rule was written — `DINING` (mig 0258), `BEDLINES` (0259), `DIFFUSER`
(0260), `CARPET` (0261), repeated onto the `scm.` enum by 0262-0265 because
0258-0261 hit the wrong schema. All four were added FOR Houzs SKUs, and
`normCategory` (`so-readiness.ts:66`) folds every one of them into OTHERS. The
blank cell was most of the Houzs catalogue.

*(2) The rule had two homes and four call sites, and reached one.* The same
category→label rule was written a second time in
`frontend/src/pages/scm-v2/ConsignmentOrders.tsx:273`. Meanwhile the SO list
handler stamps `first_item_category` + `first_item_branding`
(`mfg-sales-orders.ts:1782/1793`) and leaves the labelling to the reader — and of
the four readers, only Consignment Orders did any. `MfgSalesOrdersListV2.tsx`,
`MobileSalesOrders.tsx` and `SalesOrderDetailV2.tsx` all used
`brandOf = r.branding || r.first_item_branding || "—"`. A sofa line carries no
per-line brand text, so **the main SO list printed "—" for the same order the
Consignment Orders page printed "2990 Sofa" for, off the identical payload.**

Both copies were documented as doing something neither did: the frontend comment
promised `ACCESSORY / OTHERS → "2990"` and `mfg-sales-orders.ts:1479` promised
`else → "2990"`, each sitting directly above a `return ''`. The intent was never
blank; it just was never implemented.

**Fix.** The rule moved to `backend/src/scm/shared/so-branding-label.ts`,
mirrored byte-identically into `frontend/src/vendor/shared/so-branding-label.ts`
so `check-shared-mirrors.mjs --strict` (a required CI step) is the referee
instead of a comment asking a human to keep two files in step. It is now total —
no input of any shape returns blank — and company-aware per the owner's
per-company spec (2990 keeps the house-brand wording; a Houzs order is never
labelled "2990 …", which would be a WRONG label rather than a missing one). An
unstated company keeps the 2990 reading, so no existing caller changed meaning.
The frontend duplicate is deleted and all four readers now go through it.

**What makes the test non-vacuous.** The old suite asserted `''` for
ACCESSORY/SERVICE/OTHERS — the bug, written down as an expectation. The
replacement is a PROPERTY over a category list DERIVED from source
(`CATEGORY_SOURCES`: the enum plus its four migrations, plus normCategory's six
buckets) crossed with every brand and company shape — 2,574 combinations, and it
asserts its own domain size so an empty loop cannot pass as a clean run. Run
against the unfixed code first it reported `180 blank labels`.

**Deferred, not fixed (do not read this entry as covering them).**
`deriveDisplayBrandingByDoc` in the same file is a DIFFERENT rule — it returns
raw line branding and the literal "BEDFRAME", and omits a doc entirely when
nothing resolves, so the Sales Report and SO detail can still disagree with the
list and still render a dash. `SalesOrderDetailV2.tsx` cannot use the shared
rule until the detail endpoint stamps `first_item_category`. And the owner's
Houzs line "1. Big frame 就显示 big frame" is unresolved: **no "big frame" /
"bigframe" exists anywhere in this repo** (grep exit 1 against a control grep
returning 1,715 hits for "bedframe"), so the bedframe case uses the system's own
bedframe label rather than inventing a category.
