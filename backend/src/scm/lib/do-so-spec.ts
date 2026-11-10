/* ----------------------------------------------------------------------------
   do-so-spec — a delivery order line linked to a sales order line takes its
   spec from that SO line, on the server.

   The SO line is what was sold, and the PO and GRN were copied from it. The DO
   line used to store whatever the client sent, and the client's line card added
   things on open (a derived totalHeight, a sofa leg "Default"), so the DO keyed
   a different stock bucket from the goods received for it (PR #5609). /from-sos
   already copied the SO line on the server; POST /, POST /:id/items and PATCH
   /:id/items/:itemId now do the same.

   Only the spec fields move (shared/variant-key.ts VARIANT_SPEC_FIELDS). Other
   keys the DO line carries stay. A line whose code differs from its SO line's is
   left alone: that is a substitution, and the DO keeps what it names.
   -------------------------------------------------------------------------- */
import { VARIANT_SPEC_FIELDS } from '../shared/variant-key';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { pgrestIn } from './pgrest-in-list';

type Bag = Record<string, unknown>;

/** Pure: the DO line's variants with every spec field replaced by the SO line's. */
export function adoptSoSpec(doVariants: Bag | null, soVariants: Bag | null): Bag {
  const out: Bag = {};
  const spec = new Set<string>(VARIANT_SPEC_FIELDS);
  for (const [k, v] of Object.entries(doVariants ?? {})) if (!spec.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(soVariants ?? {})) out[k] = v;
  return out;
}

export type SoSpecLine = { soItemId?: unknown; itemCode?: unknown; variants?: unknown };

/** SO line id -> { item_code, variants }, company-scoped. Throws on a read error. */
export async function loadSoLineSpecs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  soItemIds: readonly string[],
  companyId: number | null,
): Promise<Map<string, { item_code: string | null; variants: Bag | null }>> {
  const out = new Map<string, { item_code: string | null; variants: Bag | null }>();
  const ids = [...new Set(soItemIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await scopeToCompanyIdOrOpen(
    pgrestIn(sb.from('mfg_sales_order_items').select('id, item_code, variants'), 'id', ids), companyId);
  if (error) throw new Error(`SO line spec read failed: ${error.message}`);
  for (const r of (data ?? []) as Array<{ id: string; item_code: string | null; variants: Bag | null }>) {
    out.set(r.id, { item_code: r.item_code, variants: r.variants });
  }
  return out;
}

/** Pure: apply the SO specs to request lines (camelCase body shape). */
export function applySoLineSpecs<T extends SoSpecLine>(
  items: readonly T[],
  specs: ReadonlyMap<string, { item_code: string | null; variants: Bag | null }>,
): T[] {
  return items.map((it) => {
    const so = it.soItemId ? specs.get(String(it.soItemId)) : undefined;
    if (!so) return it;
    const code = String(it.itemCode ?? '').trim();
    if (code && so.item_code && code !== so.item_code.trim()) return it;
    const variants = adoptSoSpec((it.variants as Bag | null) ?? null, so.variants);
    // Nothing on either side: keep the line's own null rather than invent `{}`.
    if (it.variants == null && Object.keys(variants).length === 0) return it;
    return { ...it, variants };
  });
}

/** The whole rule as one call for a route. */
export async function adoptSoLineSpecs<T extends SoSpecLine>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase client without generated types; project-wide pattern
  sb: any,
  items: readonly T[],
  companyId: number | null,
): Promise<T[]> {
  const ids = items.map((it) => String(it.soItemId ?? '')).filter(Boolean);
  if (ids.length === 0) return [...items];
  return applySoLineSpecs(items, await loadSoLineSpecs(sb, ids, companyId));
}
