
---

## Creating one on the phone (2026-09-13)

Before this date the phone had **no way to raise a purchase invoice at all** — the
Purchase Invoices list had no `+`, and the convert wizard has no GRN-to-PI target.
The list's `+` now opens `frontend/src/mobile/MobilePurchaseDocNew.tsx`
(`kind = "pi"`), a direct create of a MANUAL invoice (`grnId: null`,
`purchaseOrderId: null`, every line `grnItemId: null`) through the SAME
`useCreatePurchaseInvoice` hook as `PurchaseInvoiceNew`. A non-draft is then POSTED
with `usePostPurchaseInvoice`, as desktop does — **without that second call no AP
liability is recorded.**

**New frontend gate, no new permission.** `canOperatePurchaseInvoices`
(`frontend/src/auth/salesAccess.ts`) is the third arm of the same private
`canOperateScmProcurement` rule as the PO and GRN helpers: `edit` or better on
`scm.procurement.pi`, the area `backend/src/scm/index.ts` already guards
`/purchase-invoices/*` with. A `view` holder gets no `+`. Pinned in
`frontend/src/auth/procurementOperate.test.ts`.

**What is still desktop-only:** PI from a GRN (`PurchaseInvoiceFromGrn`), foreign
currency + exchange rate, freight allocation, and the product-option fields. The
unit price starts BLANK on the phone. Trace:
`docs/bugs/0872-the-phone-could-not-create-a-purchase-order-goods-receipt-or.md`.

---

## History drawer (change log)

The History button opens the recorded change log for this purchase invoice — every field
change, who made it and when — read from `scm.entity_audit_log` through
`GET /entity-audit-log/:entityType/:entityId`.

Mounted with `DocumentHistoryDrawer` (`frontend/src/pages/scm-v2/DocumentHistoryDrawer.tsx`),
which holds the per-document label and status vocabulary in one registry. The
drawer is keyed on the header row's UUID, not the document number: pass the
number and it returns an empty history that looks real.

Before 2026-09-13 this did not work, and it failed silently — the frontend's
list of auditable document types was a hand-copy of the backend's and had fallen
five names behind, so nothing could ask for this document's history while the
routes were recording it. That list is now pinned by a test that reads the
backend source. Trace:
`docs/bugs/0847-four-documents-kept-a-change-log-nobody-could-read.md`, and
`docs/modules/change-log.md` for how the drawer and the company-wide page fit
together.

---

## FOC on the line grid

A line that charges nothing shows **FOC** in its Amount cell instead of RM 0.00,
rendered by `FocAmount` (`frontend/src/vendor/scm/components/FocAmount.tsx`) over
the one shared rule, `isFocLine`.

The badge sits in the AMOUNT cell here and in the DISCOUNT cell on the sales
order, delivery order and sales invoice. That is deliberate, not drift: the three
sales documents have a Discount column on their line grid and the three purchase
documents do not. The underlying tables all store a discount; these grids do not
read it.

The allocated-freight sub-line is dropped on a free line — a freebie that carries
landed cost still cost nothing to buy, and printing both reads as two answers to
one question. Trace:
`docs/bugs/0849-a-supplier-freebie-printed-as-rm-0-00-with-nothing-to-say-it.md`.

### Adding a line by hand

The detail page carries an **Add line** button beside Edit, gated the same way
Edit is — adding a line IS an edit. It hands over to the editor with a
`#add-line` fragment; the editor opens its add row and strips the fragment, so
the intent fires once and does not survive a reload or a back button.

The word comes from `ADD_LINE_LABEL` in `vendor/scm/lib/add-line-handoff.ts`.
Four documents used to spell this four ways, and none of them said it on the page
you start from. Trace:
`docs/bugs/0853-add-a-line-was-only-reachable-from-inside-edit-under-four-di.md`.
