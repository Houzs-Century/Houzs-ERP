// ----------------------------------------------------------------------------
// Apply scheduled supplier prices on their effective date (BUG-32).
//
// Supplier → binding → "Schedule price" writes a row into
// scm.supplier_binding_price_history. Every reader of a supplier's cost — the
// PO form, Create-PO-from-SO, MRP, and the auto-derive that sets the Product
// Maintenance cost an SO is costed on — reads the FLAT
// scm.supplier_material_bindings row. Nothing copied a due history row onto
// that flat row, so a price scheduled for 1 October never reached a PO, the
// product cost or the Sales Report.
//
// This copies it. For each binding with a pending (applied_at IS NULL) row whose
// date has come, the row that is live as of today — newest effective_from, then
// newest created_at, across applied and pending rows alike — is written onto the
// flat binding, and every due pending row is marked applied. With auto-derive on,
// the product cost is then recomputed (max supplier) and its own history row is
// appended, which is the record the SO recompute reads as of the order's date.
//
// Run nightly at 00:05 MYT and right after a price is scheduled, so an
// effective-today (or back-dated) schedule applies immediately.
// ----------------------------------------------------------------------------

import { autoDeriveEnabled, recomputeDerivedProductCostSafe } from './auto-derive-cost';

// The SCM routes carry an untyped supabase-js client.
type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type SupplierPriceHistoryRow = {
  id: string;
  company_id: number;
  supplier_id: string;
  material_kind: string;
  item_code: string;
  unit_price_sen: number | null;
  price_matrix: unknown;
  effective_from: string;
  created_at: string;
  applied_at: string | null;
};

/**
 * For ONE binding's history, which row must now be live on the flat binding and
 * which pending rows are done. Pure; exported for the tests.
 *
 * `apply` is null when the live row is already applied — a later direct edit or
 * a newer schedule superseded the pending one, so the flat price stays; the
 * pending row is still marked so it is not looked at again.
 */
export function pickDueSupplierPrice(
  rows: readonly SupplierPriceHistoryRow[],
  today: string,
): { apply: SupplierPriceHistoryRow | null; markApplied: string[] } {
  const due = rows.filter((r) => r.effective_from <= today);
  const pending = due.filter((r) => r.applied_at == null);
  if (pending.length === 0) return { apply: null, markApplied: [] };
  const live = due.reduce((a, b) =>
    b.effective_from > a.effective_from || (b.effective_from === a.effective_from && b.created_at > a.created_at) ? b : a,
  );
  return { apply: live.applied_at == null ? live : null, markApplied: pending.map((r) => r.id) };
}

export type ApplyScope = {
  today: string;
  /** Narrow to one binding (the schedule endpoint). Omit all three for the nightly sweep. */
  companyId?: number;
  supplierId?: string;
  itemCode?: string;
};

export type ApplyResult = { bindings: number; applied: number; failed: number };

const HISTORY_COLS =
  'id, company_id, supplier_id, material_kind, item_code, unit_price_sen, price_matrix, effective_from, created_at, applied_at';

/**
 * Apply every due scheduled supplier price in `scope`. One binding's failure is
 * logged and left pending for the next run; it never stops the others.
 */
export async function applyDueSupplierPrices(sb: Sb, scope: ApplyScope): Promise<ApplyResult> {
  let q = sb
    .from('supplier_binding_price_history')
    .select('company_id, supplier_id, material_kind, item_code')
    .is('applied_at', null)
    .lte('effective_from', scope.today);
  if (scope.companyId != null) q = q.eq('company_id', scope.companyId);
  if (scope.supplierId) q = q.eq('supplier_id', scope.supplierId);
  if (scope.itemCode) q = q.eq('item_code', scope.itemCode);
  const { data: pendingKeys, error } = await q.order('effective_from', { ascending: true }).limit(1000);
  if (error) throw new Error(`pending supplier prices read failed: ${error.message}`);

  const keys = new Map<string, Pick<SupplierPriceHistoryRow, 'company_id' | 'supplier_id' | 'material_kind' | 'item_code'>>();
  for (const k of (pendingKeys ?? []) as Array<Pick<SupplierPriceHistoryRow, 'company_id' | 'supplier_id' | 'material_kind' | 'item_code'>>) {
    keys.set(`${k.company_id}|${k.supplier_id}|${k.material_kind}|${k.item_code}`, k);
  }

  const result: ApplyResult = { bindings: keys.size, applied: 0, failed: 0 };
  for (const k of keys.values()) {
    try {
      const { data: rows, error: hErr } = await sb
        .from('supplier_binding_price_history')
        .select(HISTORY_COLS)
        .eq('company_id', k.company_id)
        .eq('supplier_id', k.supplier_id)
        .eq('material_kind', k.material_kind)
        .eq('item_code', k.item_code)
        .lte('effective_from', scope.today);
      if (hErr) throw new Error(hErr.message);
      const { apply, markApplied } = pickDueSupplierPrice((rows ?? []) as SupplierPriceHistoryRow[], scope.today);

      if (apply) {
        const { error: uErr } = await sb
          .from('supplier_material_bindings')
          .update({
            unit_price_sen: apply.unit_price_sen,
            price_matrix: apply.price_matrix ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('company_id', k.company_id)
          .eq('supplier_id', k.supplier_id)
          .eq('material_kind', k.material_kind)
          .eq('item_code', k.item_code);
        if (uErr) throw new Error(uErr.message);
      }
      // Marked only after the flat write landed, so a failed write is retried.
      if (markApplied.length > 0) {
        const { error: mErr } = await sb
          .from('supplier_binding_price_history')
          .update({ applied_at: new Date().toISOString() })
          .eq('company_id', k.company_id)
          .in('id', markApplied);
        if (mErr) throw new Error(mErr.message);
      }
      if (apply) {
        result.applied++;
        if (k.material_kind === 'mfg_product' && (await autoDeriveEnabled(sb, k.company_id))) {
          await recomputeDerivedProductCostSafe(sb, k.company_id, k.item_code);
        }
      }
    } catch (e) {
      result.failed++;
      console.error(
        `[supplier-price-apply] ${k.company_id}/${k.supplier_id}/${k.item_code} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return result;
}
