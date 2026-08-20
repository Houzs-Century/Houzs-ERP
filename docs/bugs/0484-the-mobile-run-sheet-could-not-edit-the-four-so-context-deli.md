## The mobile run sheet could not edit the four SO-context delivery fields [medium]

<!-- area: Delivery, DO, returns -->

**Symptom.** A driver on the phone could edit the delivery-execution fields —
time window, arrival/departure, shipout, port, delivery status — but not the
four order-context fields the office edits from the desktop board: move-in
(possession) date, house type, referral, and replacement / disposal. The mobile
card also only appeared once a delivery order existed, so on an SO with no DO
there was no way to record any of them from the phone at all. The disposal field
is the one that matters on the road: the driver is who finds out at the
customer's door that the old set has to go.

**Root cause (traced).** `frontend/src/mobile/MobileDeliveryPlanning.tsx`'s
`DeliveryFieldsCard` built its PATCH body from eight keys — `timeRange`,
`timeConfirmed`, `arrivalAt`, `departureAt`, `shipoutDate`,
`customerDeliveredDate`, `etaArrivingPort`, `deliverySubstatus` — and had no
branch for the other four, while the desktop drawer
`frontend/src/vendor/scm/components/DeliveryFieldsDrawer.tsx` sends twelve to
the same `PATCH /delivery-planning/:type/:id/fields`. The backend already
accepted all twelve, so nothing server-side was missing; the mobile client
simply never offered them. The card was also rendered under `{doId && (…)}`,
which gated the SO-header half of the form on a DO it does not live on.

Adding the four naively would have shipped a second defect. `replacement_disposal`
is a CONTROLLED SO field: `backend/src/scm/routes/delivery-planning.ts` returns
409 `so_locked_processing` for a genuine disposal change on an SO that is
processing-locked or PO-locked, because the owner's 2026-07-27 ruling is that
such a change "appears in SO Amendment — Logistics reviews → approves". The
desktop drawer implements that by excluding the field from the direct PATCH and
calling `useCreateAmendment` instead. A mobile client without the routing would
have met the 409 with no path forward. `po_locked`, the second road into the
same lock, was already on the board payload
(`backend/src/scm/routes/delivery-planning.ts:954`) but was not declared on
mobile's `BoardRow`, so it could not be fed to `procLockActive`.

**Fix.** The card moved to `frontend/src/mobile/MobileDeliveryFieldsCard.tsx`
(MobileDeliveryPlanning.tsx sits under a 2,449-line ceiling and had ten lines
spare), and the save decision came out of the component as the pure exported
`buildDeliveryFieldsPatch(initial, form, { procLocked, hasDo })`. It carries the
four SO-context keys in the changed-only diff, keeps them editable with or
without a DO, gates the eight DO-execution keys on `hasDo`, and routes a
disposal change on a locked order out of the body and into an SO Amendment —
the same `procLockActive` predicate and `useCreateAmendment` mutation the
desktop drawer uses, imported rather than re-implemented. `po_locked` was added
to `BoardRow`.

Pinned by `frontend/src/mobile/mobileDeliveryFields.test.tsx`, 13 assertions
over the pure builder. It was written first and **proved RED on the unfixed
tree**: against today's behaviour ported verbatim into the new module,
10 of 13 failed — including `expected undefined to be "New House"` for the
SO-context keys and `expected { timeRange: '2pm-4pm', …(1) } to not have
property "timeRange"` for the no-DO gate. All 13 pass on the fixed tree.

**Ref.** feat/mobile-delivery-context-fields, 2026-08-21.
