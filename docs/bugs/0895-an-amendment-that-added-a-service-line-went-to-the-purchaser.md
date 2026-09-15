## An amendment that added a service line went to the Purchaser [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-14, on the Amendments inbox: 「为什么Service line item还是
purchaser approve?」 HC-SO-012757/A1 (requested 17:12 MYT, reason "last min
cancellation penalty") showed Approver = PURCHASER. Read-only on production
(`anogrigyjbduyzclzjgn`, 2026-09-14T10:15Z): the amendment is one line,
`change_type ADD`, `new_item_code 'TRANSPORTATION CHARGES'`, qty 1, RM150.00,
stored with `lane = 'LINES'`, and the catalogue row for that code in company 1 has
`category = 'SERVICE'`. The owner had already ruled service charges are the
Logistic desk's (2026-07-27) and asked the same question on 2026-09-11
(`docs/bugs/0816-a-bare-code-service-line-dispose-storage-transportation-char.md`), whose fix covered existing lines only. Counted at 10:34Z: 2
LINES-lane amendments ever carried an added SERVICE line — A1 (still REQUESTED)
and one already SO_APPROVED. HC-SO-012757 has 0 live purchase orders bound to its
lines, so approving A1 raises no PO amendment.

**Root cause (traced).** The lane is decided once, at submit, in
`POST /mfg-sales-orders/:docNo/amendments` (`backend/src/scm/routes/mfg-sales-orders.ts`):
`splitAmendmentByLane(headerChanges, submittedLines, (l) => (l.salesOrderItemId ?
identityById.get(...) : { itemCode: l.newItemCode }))`. An existing line got its
`item_group` from the SO row (the 0816 fix above); an ADDED line has no row, so it got
the code ALONE. `isServiceLine` (`shared/service-sku.ts`) recognises a service by
`item_group`, catalogue `category`, or an `SVC-` prefix — a bare code such as
TRANSPORTATION CHARGES has none of the three when only the code is passed, so
`classifyLine` answered LINES. The same code-only judgement sat in the approve
step's PO follow-up (`serviceOnlyChange` in `lib/amendment-po-followup.ts`):
`isServiceLine({ itemCode: l.new_item_code })` read the added fee as goods, and an
ADD keeps every bound PO as a candidate, so on an order WITH bound POs approval
would have raised an amendment against each of them. Observed with tests over the
unfixed tree: `classifyLine({ itemCode: 'TRANSPORTATION CHARGES', category:
'SERVICE' })` returned LINES, and `raisePoFollowUps` on that ADD with the catalogue
row present raised follow-ups on both bound POs of the fixture.

**Fix.** `catalogCategoriesByCode` (`lib/validate-item-codes.ts`) reads the
catalogue category of the added codes inside the order's company, with the same
in-list escaping as `validateItemCodes`, and answers `null` on a failed read. The
submit route passes `category` for every line with no `salesOrderItemId` and
refuses 500 if the read fails; `LineLaneIdentity` / `classifyLine` carry the
category into `isServiceLine`; the PO follow-up reads the same categories for the
new codes. Pinned by `amendment-lane.test.ts` ("routes an ADDED bare-code service
line to DELIVERY by its catalogue category"), `amendment-po-followup.test.ts`
("adding a BARE-code service line ... raises no PO amendment", plus "another
company's SERVICE row does not count"), `validate-item-codes.test.ts`
(`catalogCategoriesByCode`) and a source pin on the submit handler
(`routes/amendment-submit-lane.test.ts`) — the rule and follow-up tests proved RED
on the unfixed tree. NOT changed: a lane already stored stays — A1 keeps LINES.
The Purchaser can approve it (no PO side effect on this order), or it can be
withdrawn and raised again once this is deployed to land on Logistic.

**Ref.** `fix/amendment-added-service-line-lane`, 2026-09-14. Module guide:
`docs/modules/so-amendment.md` §1.
