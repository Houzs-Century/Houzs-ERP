/* Read-only label lookup for the DO detail GET: never touches stock. Moved out
   of routes/delivery-orders-mfg.ts (2026-11-09) when the printed DO started to
   need the warehouse NAME as well as the code label. */
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { warehouseLabel } from './warehouse-label';

export type DoWarehouseLabel = { label: string; name: string | null };

/* Scoped to the active company: the ids come from a company-scoped DO, so a
   warehouse outside it can only be a bad id, and its name must not print. */
export async function doWarehouseLabels(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client
  sb: any,
  c: CompanyScopeCtx,
  ids: Array<string | null | undefined>,
): Promise<Map<string, DoWarehouseLabel>> {
  const out = new Map<string, DoWarehouseLabel>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return out;
  const { data, error } = await scopeToCompany(sb.from('warehouses').select('id, code, name'), c).in('id', uniq);
  /* Labels only: a failed read leaves the Warehouse cells blank rather than
     failing the whole DO detail, and is logged so it is not mistaken for "no warehouse". */
  if (error) {
    console.warn('[do-warehouse-labels] warehouse read failed', error.message);
    return out;
  }
  for (const w of (data ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
    out.set(w.id, { label: warehouseLabel(w) ?? '', name: (w.name ?? '').trim() || null });
  }
  return out;
}
