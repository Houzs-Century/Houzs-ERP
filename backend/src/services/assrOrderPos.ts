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

/* HC-0130 — the supplier on the PO raised from the case item's SO line
   (SO line -> purchase_order_items.so_item_id -> purchase_orders.supplier),
   so the Solution step's SUPPLIER fills itself. CANCELLED POs are skipped;
   several suppliers -> the latest PO (po_date, then po_number). Scoped to the
   case's company like attachOrderPurchaseOrders; any read error -> null. */
export async function orderPoSupplierCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  docNo: string | null,
  itemCode: string | null,
  companyId: number | null,
): Promise<string | null> {
  if (!docNo || !itemCode || !Number.isInteger(companyId) || (companyId as number) <= 0) return null;
  try {
    const lines = await sb.from("mfg_sales_order_items").select("id")
      .eq("company_id", companyId).eq("doc_no", docNo).eq("item_code", itemCode);
    const lineIds = ((lines.data ?? []) as Array<{ id: string | null }>).map((r) => r.id).filter(Boolean);
    if (lines.error || lineIds.length === 0) return null;
    const links = await sb.from("purchase_order_items").select("purchase_order_id")
      .eq("company_id", companyId).in("so_item_id", lineIds).not("purchase_order_id", "is", null);
    const poIds = [...new Set(((links.data ?? []) as Array<{ purchase_order_id: string }>).map((r) => r.purchase_order_id))];
    if (links.error || poIds.length === 0) return null;
    const pos = await sb.from("purchase_orders").select("po_number, po_date, status, supplier:suppliers(code)")
      .eq("company_id", companyId).in("id", poIds);
    if (pos.error) return null;
    type Po = { po_number: string | null; po_date: string | null; status: string | null; supplier: { code: string | null } | null };
    const latest = ((pos.data ?? []) as Po[])
      .filter((p) => (p.status ?? "").toUpperCase() !== "CANCELLED" && p.supplier?.code)
      .sort((a, b) => (b.po_date ?? "").localeCompare(a.po_date ?? "")
        || (b.po_number ?? "").localeCompare(a.po_number ?? "", undefined, { numeric: true })).at(0);
    return latest?.supplier?.code ?? null;
  } catch {
    return null;
  }
}
