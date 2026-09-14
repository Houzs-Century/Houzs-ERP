/* ----------------------------------------------------------------------------
   assrOrderPos — "Order PO" on a service case: the supplier purchase orders
   raised from the case's SALES ORDER.

   WHY A NEW FIELD AND NOT po_no. Staff reported "create service case no have PO
   no record in the column". Two facts made that column the wrong home:
     · the ERP create path hard-codes SOUDF_ToPONo: null (fetchScmSoContext in
       services/assr.ts), so po_no is only ever filled by hand or by the old
       AutoCount getSingle path;
     · po_no is the case's OWN service purchase order. POST /:id/generate-po
       refuses once it is set, and cost resolution reads it as the PO to price
       the repair from. Writing the SO's purchase orders into it would block
       the service PO and misprice the case.
   So this is a read-only enrichment beside do_numbers, never stored.

   Source: the one SO -> PO walk the Sales Orders list already uses
   (scm/lib/so-converted-po.ts): SO line -> purchase_order_items.so_item_id ->
   purchase_orders, CANCELLED dropped, DRAFT kept.

   COMPANY. Service Cases are a cross-company queue, so one page can hold cases
   of both companies. Each case is resolved inside ITS OWN company_id — doc
   numbers are not a company boundary. A case with no company_id gets an empty
   list rather than an unscoped read.

   Fail-soft like do_numbers: a failed read leaves [] and the case still loads.
   ---------------------------------------------------------------------------- */
import { soConvertedPos, type SoConvertedPo } from "../scm/lib/so-converted-po";

export type AssrOrderPo = SoConvertedPo;

export async function attachOrderPurchaseOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const byCompany = new Map<number, Array<Record<string, unknown>>>();
  for (const r of rows) {
    r.order_pos = [];
    const companyId = Number(r.company_id);
    if (typeof r.doc_no !== "string" || !r.doc_no || !Number.isInteger(companyId) || companyId <= 0) continue;
    const group = byCompany.get(companyId) ?? [];
    group.push(r);
    byCompany.set(companyId, group);
  }
  await Promise.all(
    [...byCompany].map(async ([companyId, group]) => {
      const found = await soConvertedPos(sb, group.map((r) => r.doc_no as string), companyId);
      for (const r of group) r.order_pos = found.get(r.doc_no as string) ?? [];
    }),
  );
}
