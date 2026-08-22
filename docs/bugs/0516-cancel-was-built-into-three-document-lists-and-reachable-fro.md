## Cancel was built into three document lists and reachable from nothing [medium]

**Symptom.** The owner, 2026-08-22, right-clicking a Purchase Invoice:
「为什么我的 Purchase Invoice 是没有的呢？」 — he got Chrome's own menu. Ten
document lists, five with a right-click menu and five without. On three of the
five without, cancelling a document from the list was not merely un-offered:
the page had already built the whole capability and gave the operator no way to
reach it.

**Root cause (traced).** Three list pages each hold a cancel handler that is
called from nowhere. Verified by grepping each whole file for its own
identifier:

- `frontend/src/pages/scm-v2/StockTransfersListV2.tsx` — `doCancel` is declared,
  complete with its `window.confirm` copy, and appears nowhere else in the file.
- `frontend/src/pages/scm-v2/StockTakesListV2.tsx` — same shape, same result.
- `frontend/src/pages/scm-v2/PurchaseInvoicesListV2.tsx` — `useCancelPurchaseInvoice()`
  is called and the mutation it returns is used by nothing at all.

Nothing reported it because nothing could. `frontend/tsconfig.app.json` carries
`"noUnusedLocals": false` and `"noUnusedParameters": false`, so an unused local
is not a type error on this app; the ESLint ratchet's rules do not cover it
either. A dead handler here compiles, lints and ships, and reads in review as
working code — the reviewer sees a cancel with a confirmation dialog and has no
signal that no button calls it.

**Fix.** The right-click menu is the caller. Five new factories in
`frontend/src/pages/scm-v2/row-menus.ts` — `purchaseInvoiceRowMenu`,
`purchaseReturnRowMenu`, `deliveryReturnRowMenu`, `stockTransferRowMenu`,
`stockTakeRowMenu` — assembled by the shared `buildRowMenu`, wired into the five
lists' `DataTable contextMenu`. The three dead handlers now have a caller; the
Purchase Invoice also gains Confirm on a draft (the `/:id/post` route its own
detail page already calls) and the Delivery Return gains Cancel through the
status PATCH the list was already using for Inspected and Refunded.

Pinned by `frontend/src/pages/scm-v2/row-menus-remaining-lists.test.ts`, which
asserts the label sequence per status on all five and three cross-cutting
invariants. Proved RED on the unfixed tree: with `dangerItem` swapped for a
plain item on the Stock Take cancel, the invariant test fails
`AssertionError: Stock Take / OPEN: expected undefined to be true`, naming the
list and the status.

**What this fix deliberately does NOT do.** It adds no endpoint and no new
capability of its own — every entry calls a handler the list already had or a
route its detail page already calls. Confirm is deliberately absent from the
Stock Take menu: posting a take books an ADJUSTMENT movement per
non-zero-variance line, and the detail page's confirmation shows the operator
the variance before he agrees, which a list row cannot.

**Ref.** feat/every-document-list-has-a-right-click, 2026-08-22.
