## The PO read page and mobile still cancelled straight into a guard that refused them [medium]

**Symptom.** From 2026-09-08, "Cancel PO" on the Purchase Order READ page
(`PurchaseOrderDetailV2.tsx`, the page the owner actually opens) and on the
phone (`MobileModuleDetail.tsx`) answered *"Cancelling needs an approval first —
request the cancellation and give a reason."* and did nothing. Neither screen
offered any way to give that reason: both fire
`PATCH /mfg-purchase-orders/:id/cancel` directly, which is exactly what the new
`cancelApprovalGuard('PO')` refuses with `403 cancel_approval_required`. Only
the editor (`?edit=1`) and the list right-click had been switched to the request
flow.

**Root cause (traced).** The approval PR moved six Cancel controls onto
`useCancelRequestAction` — `SalesOrderDetail`, `SalesOrderDetailV2`,
`MfgSalesOrdersListV2`, `MobileSODetail`, `PurchaseOrderDetail` and
`PurchaseOrdersListV2`. The PO's other two surfaces kept calling the raw cancel
mutation: `PurchaseOrderDetailV2.tsx`'s `doCancel` (a plain confirm, then
`cancelPo.mutate(id)`), and the generic mobile action row for
`mfg-purchase-orders`, whose `DocAction` shape could carry a confirm but had no
way to collect a reason at all. The guard is mounted at the ROUTE, so it caught
both — correctly. The gap is that this repo's own rule says the two surfaces
change together (CLAUDE.md, *Desktop and mobile are one product*), and a
document with four Cancel controls needs all four moved or none.

**Fix.** The owner cut the PO's approval on 2026-09-09
(「PO cancelled 不需要审批，只需要 remark 原因取消」), so all four surfaces now run
ONE shared step — `frontend/src/pages/scm-v2/use-po-cancel-action.ts` on the
three desktop ones, and a new `reasonPrompt` field on the mobile `DocAction`
that merges the typed reason into the request body. The rule itself lives in the
guard rather than in the screens: `PATCH …/cancel` refuses `400 reason_required`
without one, at any status, so a surface that forgets to ask is refused the same
way a script is — which is what makes "four screens, one rule" true rather than
hoped for.

Pinned by `use-po-cancel-action.test.tsx` (a dismissed prompt cancels nothing)
and by the guard cases in `document-cancel-routes.test.ts` (no reason → 400 and
the handler never reached; a cancel the handler refused writes no ledger row
claiming it happened). Proved RED against the unfixed tree — the route suite
failed 13 of 41 before the change.

**Ref.** feat/po-cancel-reason, 2026-09-09. The flow it amends is
`docs/modules/document-cancel-approval.md`.
