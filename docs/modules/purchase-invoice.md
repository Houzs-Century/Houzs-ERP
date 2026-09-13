
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
The `+` itself is wired in `frontend/src/mobile/MobileApp.tsx` (the `module` screen's
`onNew`, checked before the convert mapping) and rendered by the `purchase-doc-new`
screen arm there.

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

**The lock is shared now (2026-09-13).** Whether the document is still open for a new
line used to be an inline `const isLocked = ...` in the desktop editor. It is
`purchaseInvoiceLinesLocked` in `frontend/src/vendor/scm/lib/line-add-lock.ts`, called by
`frontend/src/pages/scm-v2/PurchaseInvoiceDetail.tsx` AND by the phone. `lineAddLock.test.ts` scans the editor so an inline
copy cannot grow back.

**On the phone (2026-09-13).** `frontend/src/mobile/MobileAddLine.tsx`, mounted under
the line items by `frontend/src/mobile/MobileModuleDetail.tsx`, opens the add row IN
PLACE (the phone has no separate editor for this document). It is offered when
`canOperatePurchaseInvoices` passes AND the shared lock above says open — `mayAddLine` in
`frontend/src/mobile/mobile-add-line.ts` — and it posts through the same
`useAddPurchaseInvoiceItem` with the desktop add row's body. A refusal stays inline beside the row,
which keeps what was typed; the unit price starts blank. Trace:
`docs/bugs/0873-the-phone-could-not-add-a-line-to-any-document.md`.

**A trap the test caught:** this document's lock reads a missing status as OPEN
(it closes only on CANCELLED or a payment). The desktop never meets that — it asks
only once the invoice exists — but the phone header can be unloaded, so
`mayAddLine` refuses a header with no status before asking any rule.

---

## Which purchase order a LINE came from (#26, 2026-09-14)

`GET /purchase-invoices/:id` serves `source_po_id` + `source_po_number` per line,
walked `grn_item_id -> grn_items.purchase_order_item_id -> purchase_orders`. It
comes out of the SAME `purchase_order_items` read as `po_unit_price_sen`
(`attachGrnLineFacts` in `backend/src/scm/lib/pi-po-price.ts`, mapping in
`backend/src/scm/lib/line-po-ref.ts`), so the order a line names and the ordered
price beside it cannot come from two different rows. A PI-native line (no
`grn_item_id`) or a receipt line with no PO gets null and shows a dash.

Shown on: the **PO** column of `PurchaseInvoiceDetailV2`, the **PO** column of
the legacy view table and a "From PO" link above each line card in Edit
(`PurchaseInvoiceDetail`), the line card header of the create-from-GRN review
(`PurchaseInvoiceNew`, read off `GET /grns/:id`), and a **PO** row under each line
on the phone (`frontend/src/mobile/MobileLinePoRef.tsx`).

Measured read-only on 2026-09-14: 649 invoice lines; 29 (HOUZS) have no receipt
line behind them, and none of the lines that do fails to reach a purchase-order line.

---

## The PO price is STORED on the line, and shown beside the PI price (2026-09-14)

Owner, 2026-09-14, in three steps: 「create 的时候，系统肯定会把 PO 的价钱直接带过来」;
「能直接看到这个 PI 的价钱，以及之前在 PO 里的价钱是多少」; and — the part that sets
the limits — 「这只是一个 reference 的 … 我 PI 要填多少钱都是我喜欢的」. So: a
default, a stored reference, and a visible difference. **No block, no warning
dialog, no approval, no variance report, no AutoCount effect.**

**Stored, not looked up.** `scm.purchase_invoice_items.po_unit_price_sen`
(migration `20260914T0200_scm_pi_item_po_unit_price.sql`) holds the
purchase-order line's unit price as it was when the invoice line was written.
Why a column and not the join the detail page used before: an approved PO
amendment writes `unit_price_sen` on a line that is already received and invoiced
(`po-revision.ts` applies PRICE with no received floor), so a live lookup would
rewrite an existing invoice's reference under it.

- **Written only by the server**, at insert, on all four insert paths of
  `backend/src/scm/routes/purchase-invoices.ts` (`POST /`, `/from-grn-items`,
  `/from-grn`, `POST /:id/items`) through `withPoPriceSnapshot` in
  `backend/src/scm/lib/pi-po-price.ts`. A value in the request body is
  overwritten; the line PATCH's field map does not carry it, so editing the PI
  price never touches it.
- `NULL` = no purchase order behind the line, or a line written before the
  column existed. `0` = the order named no price.
- **Read** by `attachGrnLineFacts`: the stored value when present
  (`po_price_source: 'snapshot'`), otherwise the live join (`'live'`, a line not
  yet back-filled), otherwise `'none'`.
- **Back-fill** for existing lines: `backend/scripts/backfill-pi-po-unit-price.mjs`
  via the workflow *Stamp the PO price onto purchase-invoice lines*
  (`backfill-pi-po-unit-price.yml`), plan by default, staging first. It stamps
  the PO price **as of the run**, because no history of PO prices exists — the
  plan prints how many lines sit on an amended PO.

**Default at create.** `PurchaseInvoiceNew` (the create-from-GRN review) starts
each line's Unit Price at `defaultPiUnitPriceSen(po, grn)`: the PO line's price
when the order named one, otherwise the receipt line's (where a price keyed at
receiving lives when the order had none). `GET /grns/:id` serves
`po_unit_price_sen` per line for this. The two API-only convert endpoints
(`/from-grn`, `/from-grn-items`) still bill the receipt line's price — no screen
calls either of them today (grep `usePurchaseInvoiceFromGrn`,
`useCreatePisFromGrnItems`: definitions only).

**Where it shows.** One component, `PoPriceReference`
(`frontend/src/vendor/scm/components/PoPriceReference.tsx`), everywhere: the
**PO price** column on `PurchaseInvoiceDetailV2` (the billed column is now
labelled **PI price**), the legacy view table and each Edit line card in
`PurchaseInvoiceDetail`, beside the Unit Price input in `PurchaseInvoiceNew`, and
under each line on the phone (`MobileLinePoFacts` in
`frontend/src/mobile/MobileLinePoRef.tsx`) with a one-line notice at the top of
the phone's invoice screen. It says **no PO link**, **PO had no price**, or
**PO RM X** with **+RM d vs PO** when the prices differ.

**List marker.** `GET /purchase-invoices/list-po-price?piIds=` (in
`backend/src/scm/routes/purchase-invoices-list-enrichment.ts`, same company predicate as the list)
returns per invoice `{ linesDiffering, totalDiffSen, comparableLines, lines }`,
computed through the SAME `attachGrnLineFacts`. The desktop list's **vs PO
price** column (`frontend/src/pages/scm-v2/PurchaseInvoicesListV2.tsx`) reads it via `usePiListPoPriceMap`
(`frontend/src/vendor/scm/lib/pi-list-po-price.ts`): "N lines differ" /
"Matches PO" / "No PO price". The phone list has no marker: `MobileModuleList.tsx`
sits at its file-size ceiling and its list config has no per-row enrichment; the
phone shows the notice on the invoice screen instead.

**One rule, two trees.** When two prices "differ" (a PO price of 0 never does)
lives in `pi-po-price-rule.ts`, byte-identical in `backend/src/scm/lib/` and
`frontend/src/vendor/scm/lib/`, refereed by
`frontend/src/vendor/scm/lib/pi-po-price-rule.canonical.test.ts`.
