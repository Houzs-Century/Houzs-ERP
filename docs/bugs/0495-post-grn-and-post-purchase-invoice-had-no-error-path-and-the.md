## Post GRN and Post Purchase Invoice had no error path, and the checker called them CAUGHT [high]

**Symptom.** A storekeeper confirms `Post GRN GRN-2608-004? Inventory will be
received into the warehouse.`, the server refuses, and the screen says nothing
at all — no toast, no inline message, no console line. They leave believing the
goods are booked in and the warehouse is short by a whole receipt. The same hole
sat on `Post this purchase invoice? Revenue-side and AP will be updated.`

**Root cause (traced).** `usePostGrn`
(`frontend/src/vendor/scm/lib/grn-queries.ts`) and `usePostPurchaseInvoice`
(`frontend/src/vendor/scm/lib/purchase-invoice-queries.ts`) each carried an
`onSuccess` and **no `onError`**. Three of the four GRN call sites and both PI
call sites pass no per-call `onError` either
(`GoodsReceivedDetailV2.doPost`, `GoodsReceivedListV2.doPost` — `{ onSuccess }`
only, `GoodsReceivedDetail.confirmGrn`, `PurchaseInvoiceDetailV2.doPost`), and
the global `MutationCache` in `frontend/src/lib/queryClient.ts` carries only
`onSuccess: broadcastDataChanged`. So the rejection had nowhere to go.

Every sibling in those same two files already had one — `useCancelGrn`,
`useDeleteGrnItem`, `useCancelPurchaseInvoice`, `useRecordPiPayment`,
`useDeletePurchaseInvoiceItem`. The two without were exactly the two that move
stock in and book an AP liability.

**Why the gate reported clean.** `frontend/scripts/check-silent-mutations.mjs`
says `0 SILENT` and is not wrong inside its own rules: its verdict is per
**HOOK**, and `consumerHandles()` returns true as soon as ANY consumer file
awaits `mutateAsync` or reads `.isError`. `GrnNew.tsx:696` does
`await post.mutateAsync(createRes.id)` inside a try/catch, and
`PurchaseInvoiceNew.tsx` does the same — so both hooks were marked CAUGHT and
the call sites that catch nothing were never looked at. **One handling consumer
clears every other consumer of the same hook.**

**Second hole, same handler: the in-band failure.** `PATCH /grns/:id/post`
answers **200** with `{ grn, movementErrors }` (`backend/src/scm/routes/grns.ts`,
the `postGrnHandler` response). The document posts and the inventory IN is
best-effort, so a refused stock write is a success as far as `onError` is
concerned. Nothing on the frontend read that field, so a GRN could post with the
stock never moving and the operator was told it worked.
`useCancelGrn` — ten lines below in the same file — has read its `cancelErrors`
through `reportInBandFailure` since 2026-08-13 for precisely this reason.

**Fix.** `usePostGrn` gained `onError: writeFailedAs('GRN not posted — the stock
was NOT received')` and a `reportInBandFailure('GRN posted, but the stock was
not received', data)` in its `onSuccess`. `usePostPurchaseInvoice` gained
`onError: writeFailedAs('Purchase invoice not posted')`.

Pinned by `frontend/src/vendor/scm/lib/post-commit-failures.test.tsx`, five
tests. **Proved RED on the unfixed tree first** — the three that matter failed
with `AssertionError: expected "vi.fn()" to be called at least once`
(`Tests 3 failed | 2 passed`), then all five passed. The two that passed both
times are the controls: a clean 200 must still say nothing.

`check-inband-failures.mjs` now lists `frontend/src/vendor/scm/lib/grn-queries.ts`
under `movementErrors` readers (7 readers, was 6).

**Ref.** fix/silent-post-grn-pi, 2026-08-21.
