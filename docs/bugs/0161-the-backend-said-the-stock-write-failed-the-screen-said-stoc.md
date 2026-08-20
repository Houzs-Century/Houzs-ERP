## The backend said the stock write failed; the screen said "Stock OUT recorded." [high]

**Symptom.** A purchase return is created, the inventory movement is refused at
the database, and the operator is told it worked. The stock never left, the
paperwork says it did, and nobody finds out until someone counts.

**Root cause — a 200 that CARRIES a failure, and nobody reads the payload.**
`POST /purchase-returns` has returned `movementErrors` since it was written.
`useCreatePurchaseReturn` typed the response as `{id, returnNumber}` and
`PurchaseReturnNew.tsx` announced "Stock OUT recorded." unconditionally. The
backend was doing its half correctly for months; the field simply had no reader.

The three LINE verbs were worse: `writePrLineDeltaMovement` returned `void`, so
they discarded a failure they already knew about. `DELETE` answered **204**,
which has no body and cannot carry the error at all — while every sibling
line-delete (`consignment-notes`, `consignment-returns`, `delivery-returns`)
already answered `200 {ok, movementErrors?}`.

**This is a class, not one bug.** Eight backend route files return
`movementErrors`; before this fix, THREE frontend files read it — and one of
those three is a mobile wizard. The rest of the surface throws the field away.

**It is also invisible to the checker built for exactly this problem.**
`check-silent-mutations.mjs` asks whether a mutation handles a REJECTION. These
mutations resolve: HTTP 200, no exception, `onError` never fires. The failure
rides *inside* a success. A different shape needs a different check.

**Fix.** `writePrLineDeltaMovement` now returns `string[]` in the create path's
exact shape; all three verbs return it; `DELETE` moves 204 -> `200 {ok,
movementErrors?}` because a status with no body cannot report anything. A
`RECOUNT_FAILED` audit row lands too, matching the shape `grns.ts` and
`delivery-orders-mfg.ts` already use. The write still COMMITS — an edit must not
be rolled back for a ledger hiccup — but it is now loud. Frontend: one shared
`reportMovementErrors` helper in the hook layer so desktop and mobile cannot
drift apart, and `PurchaseReturnNew.tsx` stops claiming success the response
contradicts.

**Stated honestly: today's operator-visible change is the CREATE path only.**
The desktop detail page has no line editor (`useUpdatePurchaseReturnItem` and
`useDeletePurchaseReturnItem` have zero consumers, and the Edit button
navigates to an `?edit=1` param the page never reads), and mobile renders
purchase returns read-only. The line verbs are API-only; the wiring is what a
future editor inherits.

**Lesson.** Returning an error field is half a feature. A repo-wide grep for the
field's READERS is the other half, and it takes ten seconds. When a response
shape says "this may have failed", something has to be looking.

**Ref.** 2026-08-13, owner decision ("要,和创建路径一致").
