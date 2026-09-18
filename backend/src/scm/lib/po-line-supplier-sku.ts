/* ----------------------------------------------------------------------------
   po-line-supplier-sku — the supplier code a PO line carries, for ONE supplier
   and ONE item code, asked the way "convert a sales order into this PO" asks it.

   The convert path (routes/mfg-purchase-orders.ts, the append-to-PO pricing
   pass) reads this supplier's `supplier_material_bindings` row for the item code
   through `readMfgProductBindings` and writes its `supplier_sku` onto the line —
   `null` when the item is not bound to that supplier. That column is what the
   PO PDF prints as "Supplier Code" and what the AutoCount write-back sends as
   the ItemCode, so it is the code the factory builds from.

   An amendment that moves a line's ITEM CODE has to move this with it, and until
   2026-09-14 neither amendment engine did: HC-SO-013497/A1 corrected
   `9058-L(LHF)` -> `9058-1A(LHF)` and `9058-1NA` -> `9058-CNR`, the follow-up
   re-derived HC-PO-2609-064, and the lines kept `5536-L(LHF)` and `5536-1NA` —
   the wrong end piece and the wrong corner, on the column the supplier reads
   (docs/bugs/0887).
   -------------------------------------------------------------------------- */

import { readMfgProductBindings } from './supplier-bindings';

// The SCM routes carry an untyped supabase-js client; the shared reader takes the same.
type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * This supplier's own code for `itemCode`, or `null` when the item has no
 * binding to that supplier (or the binding carries no code).
 *
 * `companyId` is REQUIRED: the binding table is per company, and a caller that
 * forgot it would silently read another tenant's code. Pass `null` only when the
 * document genuinely has no company.
 *
 * Throws on a failed read — a caller rewriting a PO line must not guess.
 */
export async function supplierSkuFor(
  sb: Sb,
  args: { supplierId: string | null; itemCode: string; companyId: number | null },
): Promise<string | null> {
  const code = args.itemCode.trim();
  if (!args.supplierId || !code) return null;
  const { data, error } = await readMfgProductBindings<{ item_code: string; supplier_sku: string | null }>(sb, {
    codes: [code],
    companyId: args.companyId,
    supplierId: args.supplierId,
    select: 'item_code, supplier_sku, is_main_supplier',
  });
  if (error) throw new Error(`supplier code lookup failed for ${code}: ${error.message}`);
  // Ordered is_main_supplier DESC by the reader: the first row for the code wins,
  // exactly as the convert path's `bindByCode` takes it.
  const row = data.find((b) => b.item_code === code);
  const sku = String(row?.supplier_sku ?? '').trim();
  return sku || null;
}
