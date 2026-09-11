## DO to Sales Invoice dropped the per-line delivery date - the SI had no column for it [low]

**Symptom.** Converting a Delivery Order to a Sales Invoice (the line picker ->
New-SI form, or the mobile convert wizard) landed every invoice line with a BLANK
delivery-date box, even though the DO line carried one. Owner: "需要带上 delivery
date - DO 的 info" (DO-2609-012 -> SI). The header delivery date already carried;
only the per-line date and the PDF were missing it.

**Root cause (traced).** The shared line editor `SoLineCard` renders a per-line
delivery-date field bound to `lineDeliveryDate`, and both `mfg_sales_order_items`
and `delivery_order_items` persist `line_delivery_date`. `sales_invoice_items` had
**no such column**, so `buildItemRow` never wrote it, the `ITEM` select never
returned it, and `doLineRemaining` never carried it off the DO line - the date had
nowhere to land. The header `customer_delivery_date` did carry
(`SalesInvoiceNew.tsx`), and the customer PDF printed no delivery date at all
(`sales-invoice-pdf.ts` had no such row).

**Fix.** Migration `20260910T1251_scm_si_line_delivery_date.sql` adds
`line_delivery_date` to `scm.sales_invoice_items` (mirrors the DO line; a DATE,
untouched by the `_sen` rename; no `_overridden` companion because the SI has no
header->line date cascade).
Carried through every path: `doLineRemaining` selects + returns it; `buildItemRow`
writes it; the `ITEM` select returns it; `POST /from-dos`,
`POST /:id/items/from-do/:doId` and the New-SI create body all forward it - so
mobile, which converts via `/from-dos`, inherits it server-side with no client
change. Shown on the New-SI form (prefilled per line via `SoLineCard`), the SI
detail (new "Delivery" column), and the SI PDF (header "Delivery Date" row - a
per-line PDF column would overflow the A4 item table). Desktop + mobile land
together per `docs/modules/sales-invoice.md`. No dedicated unit test: the change is
an additive field pass-through (no arithmetic); backend + frontend typecheck and the
release-discipline + trgm audits are green, and the existing `do-line-remaining`
suites are unaffected.

**Ref.** wip/do-si-residual, 2026-09-10.
