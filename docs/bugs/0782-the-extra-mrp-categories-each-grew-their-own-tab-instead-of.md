## The extra MRP categories each grew their own tab instead of sharing Others [low]

<!-- area: Frontend + mobile -->

**Symptom.** The owner, 2026-09-10, on the fix that had just shipped:
「应该要放others 一个category把」. PR #3522 made the MRP tab list derive from the
catalogue, which fixed the real defect — DINING / BEDLINES / DIFFUSER / CARPET
order lines belonged to no tab and were dropped twice (`docs/bugs/0781-...`) —
but it gave each of those four its OWN tab. He works from four: Sofa, Bedframe,
Mattress, Accessories. He wants the rest under one Others tab.

**Root cause (traced).** `mrpViews` (`frontend/src/pages/scm-v2/mrp-views.ts`)
pushed one `MrpView` per non-core category, each carrying that category as its
own `?category=` string. Correct for visibility, wrong for the shape of the page
— and fragile: `scm.acc_register_item_group()` is `SECURITY DEFINER` granted to
`service_role` (migration `20260905T0900_acc_item_groups.sql`) precisely so a
category can be created at runtime, so the tab bar would grow a column the day
the owner added a lookup value.

**Fix.** One catch-all `MrpView` — `{ value: 'others', category: null, label:
'Others' }` — appended when the catalogue holds anything outside the four, and
never more than once. `category: null` is a distinct state from a category
string and from `'all'`: the Others tab asks the server for NO filter (it stands
for a SET, and a fake enum value in `?category=` would be filtered to nothing),
then keeps the rows no other tab claims.

The row test moves from equality (`s.category === apiCategory`) to
`rowBelongsToView`, which claims **by exclusion** for Others — a row is Others'
if it is non-empty, not one of the four, and not SERVICE. Exclusion is the
load-bearing choice: matching against the `categories` the response reported
would strand a row whose category is not in that list (a product deleted from
the catalogue, a category added between two requests, or a row the engine kept
on its item GROUP — bug 0777). A null-category row stays off every tab, so
Others does not become the bin that hides that bug.

**Tests.** `mrp-views.test.ts` and `mrpCategoryTabs.test.tsx` rewritten: every
enum member and every aligned SKU category must be claimed by SOME view
(`rowBelongsToView`), four extra categories produce exactly one Others tab, an
unregistered category lands in Others without growing a tab, Others appears only
when the catalogue has something for it, and it never steals a core row, a
service row or a null-category row. Reachability is now asserted on membership,
not on a tab NAME — the old form would pass while a row still fell through.

**Ref.** fix/mrp-others-tab, 2026-09-10.
