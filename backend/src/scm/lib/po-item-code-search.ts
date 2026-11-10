// ---------------------------------------------------------------------------
// Find a Purchase Order by an item code on one of its lines (Hookka #460: "which
// PO was this item bought under?"). The PO header has no item code, so the list
// resolves the matching PO ids first and adds them to its search as an id arm.
//
// The ids ride in the list request's URL next to the SO-reference ids
// (so-ref-search.ts), so both share ONE cap sized to the URL budget
// (paginate-all.ts URL_QUERY_BUDGET, 3,000 bytes for ids at ~45 bytes per
// quoted uuid). A code on more POs than the cap keeps the newest POs.
// ---------------------------------------------------------------------------
import type { Variables } from '../env';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { escapeForOr } from './postgrest-search';
import { withSoRefPoIds } from './so-ref-search';

type Sb = Variables['supabase'];

export const PO_SEARCH_ID_CAP = 60;

/** Ids of POs in the caller's company with a line whose item code contains the
 *  term, newest first, at most `cap`. */
export async function poIdsByItemCode(sb: Sb, c: CompanyScopeCtx, term: string | null, cap: number): Promise<string[]> {
  const s = escapeForOr(term ?? '');
  if (!s || cap <= 0) return [];
  const { data, error } = await scopeToCompany(
    sb
      .from('purchase_orders')
      .select('id, items:purchase_order_items!inner(item_code)')
      .ilike('items.item_code', `%${s}%`),
    c,
  )
    .order('po_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(cap);
  if (error) throw new Error(`PO item code lookup failed: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as Array<{ id: string | null }>;
  return [...new Set(rows.map((r) => r.id).filter((id): id is string => !!id))];
}

/** The PO list's filters with both id arms of the search resolved. Every reader
 *  of the list (page, export, facets) goes through this, so all of them match
 *  the same orders. */
export async function withPoSearchIds<F extends { q: string | null; soRefPoIds: string[]; itemCodePoIds: string[] }>(
  sb: Sb, c: CompanyScopeCtx, f: F,
): Promise<F> {
  const withSo = await withSoRefPoIds(sb, c, f);
  const soRefPoIds = withSo.soRefPoIds.slice(0, PO_SEARCH_ID_CAP);
  const seen = new Set(soRefPoIds);
  const byCode = await poIdsByItemCode(sb, c, f.q, PO_SEARCH_ID_CAP - soRefPoIds.length);
  return { ...withSo, soRefPoIds, itemCodePoIds: byCode.filter((id) => !seen.has(id)) };
}
