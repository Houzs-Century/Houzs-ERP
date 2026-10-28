/* ----------------------------------------------------------------------------
   printDocumentPdf — fetch ONE document by type + address and render its PDF,
   from anywhere. The half of the right-click print chain that talks to the API.

   `printChain.ts` decides WHAT a row may print. This decides HOW that reaches a
   printer, and it is deliberately the only new place that knows the mapping

       document type  ->  detail endpoint  ->  response keys  ->  generator

   because eight list pages already each held one arm of it privately
   (`fetchSoBundle`, `fetchDoBundle`, `fetchGrnBundle`, …) and a ninth copy
   written for the row menu would be the ninth chance for one of them to drift.

   NOTHING NEW IS RENDERED. Every call below is the generator the document's own
   detail page and its list's batch "Export PDF" already call, with the same
   arguments in the same order. This module chooses between them; it does not
   lay out a document.

   ── "PRINT NOW" GOES THROUGH THE PDF, NEVER window.print() ────────────────
   The global `@media print` block in `index.css` hides `body *` and reveals only
   `.org-print-area`, so `window.print()` from a list prints a blank sheet — the
   Delivery Order shipped exactly that once. `PdfAction` is threaded to every
   generator here for that reason: `'print'` renders the real document and sends
   THAT to the printer.

   ── THE SALES ORDER IS ADDRESSED DIFFERENTLY, AND IT IS NOT AN OVERSIGHT ──
   `GET /mfg-sales-orders/:docNo` is keyed by the document NUMBER; every other
   detail route is `.eq('id', ...)` and takes a UUID. `PrintTarget.key` already
   carries whichever one the type needs, so nothing here re-derives it.
   ---------------------------------------------------------------------------- */

import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import type { PdfAction } from "../vendor/scm/lib/pdf-common";
import type { PrintTarget } from "./printChain";

type Json = Record<string, unknown>;
/* `payments` / `pwpCodes` ride BESIDE the header rather than inside it: the
   Sales Order generator takes them as its own positional arguments, and folding
   them into the header would put two keys on the object every other generator
   spreads. */
type Bundle = { header: Json; items: unknown[]; payments?: unknown[]; pwpCodes?: unknown[] };

/** The DR generator takes a shape the DR record is not stored in, so the map is
 *  written once here and the Delivery Returns list's batch export calls it too.
 *  Migration 0102 put the DO-clone address block on the record; the printout
 *  ignored it until the owner's UI audit (Item #9), which is why every address
 *  field is threaded rather than left to a default. */
export function deliveryReturnPdfBundle(data: {
  deliveryReturn?: Json | null;
  items?: Json[] | null;
}): Bundle {
  const h = data.deliveryReturn ?? {};
  return {
    header: {
      return_number: h.return_number as string,
      status: h.status as string,
      return_date: h.return_date as string,
      debtor_code: (h.debtor_code as string | null) ?? null,
      debtor_name: h.debtor_name as string,
      reason: (h.reason as string | null) ?? null,
      refund_sen: h.local_total_sen as number,
      notes: ((h.note as string | null) ?? (h.notes as string | null)) ?? null,
      delivery_order_id: (h.delivery_order_id as string | null) ?? null,
      sales_invoice_id: null,
      address1: (h.address1 as string | null) ?? null,
      address2: (h.address2 as string | null) ?? null,
      city: (h.city as string | null) ?? null,
      state: (h.customer_state as string | null) ?? (h.state as string | null) ?? null,
      postcode: (h.postcode as string | null) ?? null,
      phone: (h.phone as string | null) ?? null,
      email: (h.email as string | null) ?? null,
    },
    items: (data.items ?? []).map((it) => ({
      item_code: it.item_code as string,
      description: (it.description as string | null) ?? null,
      qty_returned: it.qty_returned as number,
      condition: (it.condition as string | null) ?? null,
      unit_price_sen: it.unit_price_sen as number,
      refund_sen: it.line_total_sen as number,
    })),
  };
}

/** The Purchase Order print needs its ship-to warehouse resolved: the PO header
 *  carries `purchase_location_id` only and jspdf cannot call the API. The detail
 *  page reads it from the `useWarehouses` cache; a right-click has no such
 *  cache, so this reads the same small table directly. ONE request, on the
 *  click — never per row. Owner 2026-07-24: DELIVER TO shows the warehouse CODE
 *  only, never "code · name". */
async function purchaseOrderHeaderForPdf(po: Json): Promise<Json> {
  let code: string | null = null;
  let location: string | null = null;
  const wid = po.purchase_location_id as string | null;
  if (wid) {
    /* A FAILED READ MUST NOT BECOME "no warehouse". This used to end in
       `.catch(() => undefined)`, which prints the supplier's copy of the PO with
       an EMPTY Deliver-to — telling the supplier to ship nowhere in particular
       because a lookup blipped. It is the same shape as the Sales Order payments
       read below, and `check-swallowed-reads.mjs` caught it. The error
       propagates; the caller shows a sentence and NO document. */
    const res = await authedFetch<{ warehouses?: Array<Json> }>("/inventory/warehouses?includeInactive=true");
    const wh = (res.warehouses ?? []).find((w) => w.id === wid);
    code = (wh?.code as string | null) ?? null;
    location = (wh?.location as string | null) ?? null;
  }
  return {
    ...po,
    purchase_location_name: code,
    delivery_address: location,
    your_ref_no: (po.your_ref_no as string | null) ?? null,
    source_so_doc_no: (po.source_so_doc_no as string | null) ?? null,
  };
}

/** A few identifying lines for the print preview card, so the operator can see
 *  they picked the right document BEFORE a printer runs. Deliberately shallow —
 *  the card is a summary, not a rendered PDF (owner's pick, 2026-08-06). */
export function printPreviewRows(target: PrintTarget, header: Json): Array<{ label?: string; value: string }> {
  const s = (k: string): string | null => {
    const v = header[k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const party =
    s("debtor_name") ??
    ((header.supplier as Json | null)?.name as string | undefined) ??
    null;
  const date =
    s("so_date") ?? s("do_date") ?? s("invoice_date") ?? s("return_date") ??
    s("received_at") ?? s("po_date") ?? null;
  const rows: Array<{ label?: string; value: string }> = [];
  if (party) rows.push({ label: target.doc === "so" || target.doc === "do" || target.doc === "si" || target.doc === "dr" ? "Customer" : "Supplier", value: party });
  if (date) rows.push({ label: "Date", value: date.slice(0, 10) });
  const status = s("status");
  if (status) rows.push({ label: "Status", value: status });
  return rows;
}

/** Load a document's header + items. Separated from the render so the preview
 *  card can be filled from the header without drawing a PDF nobody asked for. */
export async function fetchPrintBundle(target: PrintTarget): Promise<Bundle> {
  const k = encodeURIComponent(target.key);
  switch (target.doc) {
    case "so": {
      const [detail, pay] = await Promise.all([
        authedFetch<{ salesOrder: Json; items: unknown[]; pwpCodes?: unknown[] }>(`/mfg-sales-orders/${k}`),
        authedFetch<{ payments?: unknown[] }>(`/mfg-sales-orders/${k}/payments`),
      ]);
      return {
        header: detail.salesOrder,
        items: detail.items,
        /* `?? []` is safe HERE and nowhere above it: we are past the await, so
           the request SUCCEEDED and the server simply omitted the key on an SO
           with no payments. An empty array is an answer; the absence of a
           response is not.

           A FAILED PAYMENTS READ MUST PROPAGATE, and this is the one place that
           decides it. The read was "best effort" until 2026-07-19
           (`.catch(() => ({ payments: [] }))`) so the PDF "still renders" — but
           this PDF LEAVES THE BUILDING. An empty Payments table does not degrade
           gracefully, it states a FALSE FACT: the customer has paid nothing and
           owes the full total. "The read failed" became "nothing was paid" — the
           same shape as #653 (MobilePOD told a driver to re-collect a paid
           order) and #1158. Every caller wraps this in an error notice, so the
           operator gets a sentence and NO document. Not printing is recoverable;
           handing a customer a wrong statement of what they owe is not. */
        payments: pay.payments ?? [],
        pwpCodes: detail.pwpCodes ?? [],
      };
    }
    case "do": {
      const j = await authedFetch<{ deliveryOrder: Json; items: unknown[] }>(`/delivery-orders-mfg/${k}`);
      /* armDoScanToken puts the PUBLIC scan token on the header, which is what
         the print's QR encodes since 2026-08-26 (/d/<token>, no login). Stamped
         here for the same reason the row id used to be: so no call site has to
         remember to. */
      const { armDoScanToken } = await import("../vendor/scm/lib/do-scan-token-arm");
      return { header: await armDoScanToken(j.deliveryOrder as object, target.key), items: j.items };
    }
    case "si": {
      const j = await authedFetch<{ salesInvoice: Json; items: unknown[] }>(`/sales-invoices/${k}`);
      return { header: j.salesInvoice, items: j.items };
    }
    case "dr": {
      const j = await authedFetch<{ deliveryReturn: Json; items: Json[] }>(`/delivery-returns/${k}`);
      return deliveryReturnPdfBundle(j);
    }
    case "po": {
      const j = await authedFetch<{ purchaseOrder: Json; items: unknown[] }>(`/mfg-purchase-orders/${k}`);
      return { header: await purchaseOrderHeaderForPdf(j.purchaseOrder), items: j.items };
    }
    case "grn": {
      const j = await authedFetch<{ grn: Json; items: unknown[] }>(`/grns/${k}`);
      return { header: j.grn, items: j.items };
    }
    case "pi": {
      const j = await authedFetch<{ purchaseInvoice: Json; items: unknown[] }>(`/purchase-invoices/${k}`);
      return { header: j.purchaseInvoice, items: j.items };
    }
    case "pr": {
      const j = await authedFetch<{ purchaseReturn: Json; items: unknown[] }>(`/purchase-returns/${k}`);
      return { header: j.purchaseReturn, items: j.items };
    }
    default:
      /* The consignment family and the two stock documents are TransferDoc
         members with no generator of their own; printChain.ts never builds a
         target for one, and a thrown error is better than a silent no-op if it
         ever does. */
      throw new Error(`No PDF generator for document type "${target.doc}"`);
  }
}

/** Render an already-fetched bundle. `action` decides the exit: 'preview' opens
 *  a tab, 'print' sends the PDF to the printer, 'save' downloads it.
 *
 *  WHY EVERY CALL CASTS. What comes back from `authedFetch` is JSON — the header
 *  is `Record<string, unknown>` and there is nothing here that could narrow it —
 *  while each generator's own header/item types are MODULE-PRIVATE, so an
 *  outside caller has no name for them. `Parameters<typeof fn>` takes the type
 *  from the FUNCTION rather than repeating it, so a generator that changes its
 *  shape changes this cast with it. Deliberately not `as never`, which turns the
 *  check off instead of naming what it should be
 *  (`scripts/eslint/houzs-lint-rules.mjs`). */
export async function renderPrintBundle(target: PrintTarget, bundle: Bundle, action: PdfAction): Promise<void> {
  const { header, items } = bundle;
  switch (target.doc) {
    case "so": {
      const { generateSalesOrderPdf } = await import("../vendor/scm/lib/sales-order-pdf");
      type A = Parameters<typeof generateSalesOrderPdf>;
      return generateSalesOrderPdf(
        header as unknown as A[0], items as unknown as A[1],
        (bundle.payments ?? []) as unknown as A[2], action, (bundle.pwpCodes ?? []) as unknown as A[4],
      );
    }
    case "do": {
      const { generateDeliveryOrderPdf } = await import("../vendor/scm/lib/delivery-order-pdf");
      type A = Parameters<typeof generateDeliveryOrderPdf>;
      return generateDeliveryOrderPdf(header as unknown as A[0], items as unknown as A[1], { action });
    }
    case "si": {
      const { generateSalesInvoicePdf } = await import("../vendor/scm/lib/sales-invoice-pdf");
      type A = Parameters<typeof generateSalesInvoicePdf>;
      return generateSalesInvoicePdf(header as unknown as A[0], items as unknown as A[1], { action });
    }
    case "dr": {
      const { generateDeliveryReturnPdf } = await import("../vendor/scm/lib/delivery-return-pdf");
      type A = Parameters<typeof generateDeliveryReturnPdf>;
      return generateDeliveryReturnPdf(header as unknown as A[0], items as unknown as A[1], { action });
    }
    case "po": {
      const { generatePurchaseOrderPdf } = await import("../vendor/scm/lib/purchase-order-pdf");
      type A = Parameters<typeof generatePurchaseOrderPdf>;
      return generatePurchaseOrderPdf(header as unknown as A[0], items as unknown as A[1], { action });
    }
    case "grn": {
      const { generateGrnPdf } = await import("../vendor/scm/lib/grn-pdf");
      type A = Parameters<typeof generateGrnPdf>;
      return generateGrnPdf(header as unknown as A[0], items as unknown as A[1], { action });
    }
    case "pi": {
      const { generatePurchaseInvoicePdf } = await import("../vendor/scm/lib/purchase-invoice-pdf");
      type A = Parameters<typeof generatePurchaseInvoicePdf>;
      return generatePurchaseInvoicePdf(header as unknown as A[0], items as unknown as A[1], { action });
    }
    case "pr": {
      const { generatePurchaseReturnPdf } = await import("../vendor/scm/lib/purchase-return-pdf");
      type A = Parameters<typeof generatePurchaseReturnPdf>;
      return generatePurchaseReturnPdf(header as unknown as A[0], items as unknown as A[1], { action });
    }
    default:
      throw new Error(`No PDF generator for document type "${target.doc}"`);
  }
}
