## The sales order tab said "In Production" and the pill said "Proceed" [low]

**Symptom.** On the Sales Orders list the filter TAB reads **In Production**
while the status PILL on the same rows reads **Proceed**. One rung, two words,
on one screen — the same shape as the SUBMITTED / Confirmed defect the owner
reported on 2026-09-13.

**Root cause.** Both words are his, given on different days, and they landed in
two places that nothing compared: `so-list-status.ts` (the tab) says
"In Production"; `status-pill.ts` (the canonical map) said "Proceed". Sixteen
list and detail pages declare their own `{ tone, label }` map, which is the
standing root cause recorded in `docs/modules/document-status-vocabulary.md`.

Found by `localStatusMapsAgree.test.ts` — the scan that compares every page's
hand-written status map against the canonical one. It reported this as a
DELIBERATE difference with the reason "OPEN — the owner decides", rather than
aligning it, because picking one of his own two words for him is not a
correctness call.

**Fix.** He chose, 2026-09-13: 「SO 就写 in production」. `IN_PRODUCTION` now
reads **In Production** in `status-pill.ts` and in the V1 detail page's map, so
the tab and the pill agree on his word. The scan's recorded exception for this
rung is DELETED in the same change — an exemption that no longer describes a
real difference is a waiver on a future regression.

**Not changed:** `ConsignmentOrders.tsx` keeps "Proceed" for its own
`IN_PRODUCTION`. He named the SALES ORDER, and the consignment order is a
different document with its own lifecycle; sweeping it in would be renaming
something nobody asked about — the mistake that cost `docs/bugs/0855`.

**Ref.** fix/so-reads-in-production, 2026-09-13.
