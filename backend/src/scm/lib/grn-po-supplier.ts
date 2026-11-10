/* A goods receipt has ONE supplier, and every PO line it ticks off must be on a
 * purchase order from that supplier (sister review G3; Hookka ff023df2b).
 *
 * The batch path `/from-pos` refused `mixed_suppliers` and `/from-po-items`
 * groups one GRN per supplier, but the manual create (`POST /`), the add-line
 * (`POST /:id/items`) and the header edit (`PATCH /:id` changing supplierId)
 * compared only the PO's status, hold and company. A receipt for supplier A
 * could then draw down supplier B's PO line: B's PO reads "received" for goods
 * that never came, and A's GRN (and the bill and payable built from it)
 * carries B's goods.
 *
 * A failed read is a 503, never a pass: "could not check" must not be spelled
 * like "checked and fine". */
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';

export type GrnPoSupplierCheck =
  | { ok: true }
  | {
      ok: false;
      status: 409;
      body: { error: 'po_supplier_mismatch'; reason: string; poItemId: string; poNumber: string | null; poSupplierId: string | null; grnSupplierId: string };
    }
  | { ok: false; status: 503; body: { error: 'po_supplier_unavailable'; reason: string } };

type PoLineSupplierRow = { id: string; po: { po_number: string | null; supplier_id: string | null } | Array<{ po_number: string | null; supplier_id: string | null }> | null };

export async function assertPoLinesFromSupplier(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  c: CompanyScopeCtx,
  poItemIds: Array<string | null | undefined>,
  grnSupplierId: string,
): Promise<GrnPoSupplierCheck> {
  const ids = [...new Set(poItemIds.filter((v): v is string => typeof v === 'string' && v.length > 0))];
  if (ids.length === 0) return { ok: true };
  const { data, error } = await scopeToCompany(
    sb.from('purchase_order_items').select('id, po:purchase_orders!inner ( po_number, supplier_id )').in('id', ids),
    c,
  );
  if (error) {
    return { ok: false, status: 503, body: { error: 'po_supplier_unavailable', reason: `purchase_order_items: ${String((error as { message?: string }).message ?? error)}` } };
  }
  const byId = new Map<string, { po_number: string | null; supplier_id: string | null } | null>();
  for (const r of (data ?? []) as PoLineSupplierRow[]) byId.set(r.id, Array.isArray(r.po) ? (r.po[0] ?? null) : r.po);
  for (const id of ids) {
    const po = byId.get(id) ?? null;
    if (po && po.supplier_id && String(po.supplier_id) === String(grnSupplierId)) continue;
    return {
      ok: false,
      status: 409,
      body: {
        error: 'po_supplier_mismatch',
        reason: po
          ? `Purchase order ${po.po_number ?? ''} is from a different supplier. One goods receipt receives from one supplier; receive this line on that supplier's receipt.`.replace('  ', ' ')
          : 'A purchase order line on this receipt could not be read back, so its supplier cannot be confirmed. Pick the line again.',
        poItemId: id,
        poNumber: po?.po_number ?? null,
        poSupplierId: po?.supplier_id ?? null,
        grnSupplierId,
      },
    };
  }
  return { ok: true };
}
