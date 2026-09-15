## Delivery Planning had no Reference column: the SO referral tag was dropped from the board and the Columns panel could not find it [low]

<!-- area: Fleet, trips, TMS -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, on Delivery Planning with the Columns panel
open and "ref" typed into its search: 「delivery planning 没有reference number
选项」 — *No columns match "ref"*, 42 of 44 columns listed. Then: 「还有要PO
number」. The board's own search box promises "Search SO / ref / customer /
phone…", which made the missing column read as a bug, not a choice.

**Root cause (traced).** Not a data gap. `GET /delivery-planning`
(`backend/src/scm/routes/delivery-planning.ts`) still selects and stamps
`referral` on every SO row, `PlanningOrder` still types it, and the mobile
stop detail (`MobileDeliveryPlanning.tsx`) still renders it as "Reference".
The column was REMOVED on purpose in the owner's 2026-08-04 column pass
(#1595, `238f8128c`): `DeliveryPlanningBoard.tsx` lost the `referral` column
definition and its `DP_DEFAULT_ORDER` entry, with the note "they answer a
sales question, not a dispatch one". The "ref" in the search placeholder is
the ASSR case ref (`o.ref`), a different field — so search found service-case
rows by ref while the panel had nothing called Reference to offer. PO No. had
never been on this board at all: the raised-PO walk (`lib/so-converted-po.ts`)
served only the SO list and the service-case detail.

**Fix.** `DeliveryPlanningBoard.tsx` gets two default-hidden columns —
**Reference** (`referral`; labelled "Reference", not "Referral", so the panel
search that failed now finds it) and **PO No.** (`po_nos`) — both in
`DP_DEFAULT_ORDER` so the Columns panel lists them in their theme block.
`/delivery-planning` stamps `po_nos` on SO rows through the new
`backend/src/scm/lib/planning-po-nos.ts`, which groups the shared
cross-company queue by `company_id` and runs `soConvertedPoNumbers` once per
company (the per-company predicate is what keeps the other book's PO off a
shared doc_no); `planning-po-nos.test.ts` pins that grouping and that a row
with no company is never walked unscoped. The mobile stop detail gains a
"PO No." row under "Reference" (one product, two surfaces). Default-hidden on
purpose: the owner asked for the OPTION, and a saved layout must not move.

**Ref.** feat/dp-board-reference-column, #3961, 2026-09-15. **Corrected the same day by 0934:** the Reference column had been wired to `referral`, which is empty on every order; it reads `ref` now.
