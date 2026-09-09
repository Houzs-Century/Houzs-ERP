## The appointed cancellation approvers could not sign — the area guard asked for the document's area, not the approve key [high]

<!-- area: Auth, permissions, sessions -->
<!-- status: fixed -->

**Symptom.** Owner 2026-09-08, appointing the chain for the new two-signature
cancellation (#3223): 「需要先给 sales director 审批才到 purchaser 审批」 —
Sales Director signs level 1, Purchaser signs level 2, on both documents. With
the keys granted on prod, neither could actually sign the document they were
appointed to: the Sales Director's position holds no `scm.procurement` area at
all, so `POST /mfg-purchase-orders/:id/cancel-request/approve` would answer
403 from the area guard before the handler ran; the Purchaser's position
(Operation Executive) has `scm.sales.orders` at `view`, so the level-2 approve
on a Sales Order would be refused the same way. Observed from prod's
`position_page_access` rows for the two positions (query 2026-09-08), not from
a user report — the keys had been granted minutes earlier and nobody had
pressed the button yet.

**Root cause (traced).** `scm/index.ts` mounts the cancel-request routers on
the two document prefixes so they inherit the document's area guard
(`scmAreaGuard("scm.procurement.po")` / `scmAreaGuard("scm.sales.orders")`),
and `scm/middleware/area-guard.ts` treats every POST as a write needing the
area's `edit` for an L2-configured caller. That is the right rule for editing
a Purchase Order and the wrong question for signing a cancellation: the area
level answers "may this person work on POs", the approve key answers "may this
person sign" — and #3223 made the handler check the key but left the door in
front of it keyed on the area. The guard already carried the escape hatch for
exactly this shape (`writeBypass`, used by the DO scan-confirm for
`scm.do.load`); it was not used.

**Fix.** `cancelApproverWriteBypass(docType)`
(`backend/src/scm/routes/document-cancel-routes.ts`) passed as `writeBypass` on
both mounts: admits ONLY `POST …/cancel-request/{approve,reject,withdraw}` for
a holder of that document's `approve_l1` or `approve_l2`; the handler still
runs the per-request refusals. `/cancel-request` added to `openReadPaths` so
the card on the document loads for the approver. Pinned by the predicate test
in `document-cancel-routes.test.ts` (the three verbs admitted on the key;
raising a request NOT admitted; the other document's key does not open the
prefix; any other write stays behind the area). Not proved red on the unfixed
tree: the predicate did not exist there, and the refusal lives in the area
guard's own behaviour with prod page-access data — the evidence is the
position rows above, not a failing test.

**Ref.** fix/cancel-approver-area-bypass-0908, 2026-09-08.
