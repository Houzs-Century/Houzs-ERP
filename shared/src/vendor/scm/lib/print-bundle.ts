
import type { ScmJsonGetter } from './supplier-doc-data-core';

type Json = Record<string, unknown>;
export type PrintBundle = { header: Json; items: unknown[]; payments?: unknown[]; pwpCodes?: unknown[] };

/** The Purchase Order print needs its ship-to warehouse resolved: the PO header
 *  carries `purchase_location_id` only and jspdf cannot call the API. The detail
 *  page reads it from the `useWarehouses` cache; a right-click has no such
 *  cache, so this reads the same small table directly. ONE request, on the
 *  click — never per row. Owner 2026-07-24: DELIVER TO shows the warehouse CODE
 *  only, never "code · name". */
export async function purchaseOrderHeaderForPdf(getJson: ScmJsonGetter, po: Json): Promise<Json> {
  let code: string | null = null;
  let location: string | null = null;
  const wid = po.purchase_location_id as string | null;
  if (wid) {
    const res = await getJson<{ warehouses?: Array<Json> }>("/inventory/warehouses?includeInactive=true");
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

/** A Sales Order's printout data: GET /mfg-sales-orders/:docNo + its payments ledger. */
export async function salesOrderPrintBundle(getJson: ScmJsonGetter, docNo: string): Promise<PrintBundle> {
  const k = encodeURIComponent(docNo);
  const [detail, pay] = await Promise.all([
    getJson<{ salesOrder: Json; items: unknown[]; pwpCodes?: unknown[] }>(`/mfg-sales-orders/${k}`),
    getJson<{ payments?: unknown[] }>(`/mfg-sales-orders/${k}/payments`),
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

/** A Purchase Order's printout data: GET /mfg-purchase-orders/:id + its ship-to warehouse. */
export async function purchaseOrderPrintBundle(getJson: ScmJsonGetter, id: string): Promise<PrintBundle> {
  const k = encodeURIComponent(id);
  const j = await getJson<{ purchaseOrder: Json; items: unknown[] }>(`/mfg-purchase-orders/${k}`);
  return { header: await purchaseOrderHeaderForPdf(getJson, j.purchaseOrder), items: j.items };
}
