// One physical warehouse exists as one scm.warehouses record PER COMPANY, with
// the same `code` (KL WAREHOUSE under HOUZS and under 2990 is one building). A
// rack is materialised as one row per warehouse record, so a shelf the two
// companies share needs the label created under each record. This picks the
// OTHER companies' records that carry a chosen target's code, so one create can
// fan out across companies without the caller naming foreign warehouse ids.

export type WarehouseRef = { id: string; code: string; company_id: number | null };

const normCode = (code: string | null | undefined): string => String(code ?? '').trim().toUpperCase();

/**
 * The warehouse records of OTHER companies whose code matches one of the
 * chosen targets. Pool is already limited to the companies the caller may see;
 * the active company's own records are never returned (they are the targets,
 * or deliberately not chosen), and a record with no company is skipped because
 * the rack row it would get could not be stamped.
 */
export function siblingWarehouses(
  targets: ReadonlyArray<WarehouseRef>,
  pool: ReadonlyArray<WarehouseRef>,
  activeCompanyId: number,
): WarehouseRef[] {
  const codes = new Set(targets.map((t) => normCode(t.code)).filter(Boolean));
  const chosen = new Set(targets.map((t) => t.id));
  const seen = new Set<string>();
  const out: WarehouseRef[] = [];
  for (const w of pool) {
    if (chosen.has(w.id) || seen.has(w.id)) continue;
    if (w.company_id == null || w.company_id === activeCompanyId) continue;
    if (!codes.has(normCode(w.code))) continue;
    seen.add(w.id);
    out.push(w);
  }
  return out;
}
