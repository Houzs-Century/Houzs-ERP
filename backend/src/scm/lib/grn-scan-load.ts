// ---------------------------------------------------------------------------
// grn-scan-load — the DB reads behind the GR scan matcher, kept out of the pure
// matcher (grn-scan-match.ts) so that stays unit-testable. Loads the OPEN,
// receivable PO lines a scanned delivery order could clear, plus the supplier
// SKU bindings that bridge the supplier's Article No / Barcode to our item code.
//
// Company-scoped: the caller passes the scan job's companyId. A null companyId
// (legacy / cold-start) loads unscoped, matching how the rest of the scan
// pipeline degrades — the convert core re-scopes and re-validates every pick.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { isDocumentHeld } from './document-hold';
import { RECEIVABLE_PO_STATUSES } from './source-document-gates';
import type { OpenPoLine, SupplierSkuBinding } from './grn-scan-match';

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

// The open+receivable PO lines in scope, with remaining qty computed. Held POs
// are excluded here so the matcher never picks one (the convert core would
// reject the whole batch with po_not_receivable if it did).
export async function loadOpenPoLines(
  svc: SupabaseClient,
  companyId: number | null,
): Promise<OpenPoLine[]> {
  let q = svc
    .from('purchase_order_items')
    .select(`
      id, purchase_order_id, item_code, material_name, supplier_sku, qty, received_qty,
      po:purchase_orders!inner ( id, po_number, supplier_id, status, on_hold, company_id )
    `)
    .in('purchase_orders.status', RECEIVABLE_PO_STATUSES as unknown as string[]);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q.limit(5000);
  if (error) throw new Error(`load open PO lines failed: ${error.message}`);

  type Row = {
    id: string; purchase_order_id: string; item_code: string | null;
    material_name: string | null; supplier_sku: string | null;
    qty: number | null; received_qty: number | null;
    po: { id: string; po_number: string; supplier_id: string | null; status: string | null; on_hold: boolean | null } | null;
  };
  const out: OpenPoLine[] = [];
  for (const r of ((data ?? []) as unknown as Row[])) {
    if (!r.po || isDocumentHeld(r.po)) continue; // held PO is not receivable
    const remaining = (r.qty ?? 0) - (r.received_qty ?? 0);
    if (remaining <= 0) continue; // nothing left to receive on this line
    out.push({
      poItemId: r.id,
      poId: r.purchase_order_id,
      poNumber: r.po.po_number,
      supplierId: r.po.supplier_id ?? null,
      itemCode: r.item_code ?? '',
      materialName: r.material_name ?? null,
      supplierSku: r.supplier_sku ?? null,
      remaining,
    });
  }
  return out;
}

// The supplier_material_bindings rows for the company: supplier SKU / AutoCount
// code -> our item code. Only rows carrying a usable mapping are returned.
export async function loadSupplierBindings(
  svc: SupabaseClient,
  companyId: number | null,
): Promise<SupplierSkuBinding[]> {
  let q = svc
    .from('supplier_material_bindings')
    .select('supplier_sku, ac_item_code, item_code');
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q.limit(20000);
  if (error) throw new Error(`load supplier bindings failed: ${error.message}`);
  type Row = { supplier_sku: string | null; ac_item_code: string | null; item_code: string | null };
  const out: SupplierSkuBinding[] = [];
  for (const r of ((data ?? []) as unknown as Row[])) {
    const itemCode = (r.item_code ?? '').trim();
    if (!itemCode) continue;
    if (!r.supplier_sku && !r.ac_item_code) continue;
    out.push({ supplierSku: r.supplier_sku ?? null, acItemCode: r.ac_item_code ?? null, itemCode });
  }
  return out;
}
