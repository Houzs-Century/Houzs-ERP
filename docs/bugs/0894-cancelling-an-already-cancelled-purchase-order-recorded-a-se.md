## Cancelling an already-cancelled purchase order recorded a second cancellation [low]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Nobody saw it happen — found while extending the reason-only cancel
to the delivery order (owner 2026-09-14). A second cancel of a purchase order
that was already cancelled — a second browser tab, a stale list, a double click —
answered success AND wrote a second `EXECUTED` row into
`scm.document_cancel_requests` plus a second `CANCEL` row on the PO's History,
each carrying the second reason, although that call cancelled nothing. Production
had NOT seen it: 0 purchase orders with more than one `EXECUTED` cancellation row,
counted read-only on `anogrigyjbduyzclzjgn` at 2026-09-14T09:27Z (3 PO rows in
the table).

**Root cause (traced).** `reasonOnlyCancel` in
`backend/src/scm/routes/document-cancel-routes.ts` records the cancellation
whenever the handler answered 2xx (`if (!c.res.ok || !before) return;`). The PO
cancel handler does not refuse a PO that is already cancelled — it answers 200
and echoes the state (`cancelPurchaseOrderHandler` in
`backend/src/scm/routes/mfg-purchase-orders.ts`:
`if (curStatus === 'CANCELLED') return c.json({ purchaseOrder: { id, status: 'CANCELLED' } })`).
So "the handler said 2xx" was true of a call that changed nothing — the check
that answers a different question. The delivery order's status handler has the
same echo ("Already cancelled → echo back"), so the DO rule would have inherited
it. Observed with a route test: PATCH cancel with a reason on a PO whose status
is `CANCELLED` wrote **1** ledger row, where 0 was expected.

**Fix.** `reasonOnlyCancel` now returns without recording when the document's
status read BEFORE the call was already `CANCELLED`. Pinned by
`document-cancel-routes.test.ts` "a purchase order that is ALREADY cancelled
records no second cancellation" — proved RED on the unfixed tree (`expected [ {…} ]
to have a length of +0 but got 1`) — and for the delivery order by "a delivery
order that is ALREADY cancelled records nothing new". Not closed: two cancels
that race (both read a live status, one handler wins, the other gets the same
200 echo) can still each write a row; both people did press cancel with a reason,
and the handlers' responses give the guard no way to tell the two apart.

**Ref.** `feat/do-cancel-reason`, 2026-09-14. Module guide:
`docs/modules/document-cancel-approval.md` §3.
