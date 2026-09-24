/* Column-funnel option counts for the Purchase Orders list, over EVERY order the
   list's filters match (all pages), not just the loaded page (DEV-13: the Doc
   Date funnel said 34 before a click and 42 after). Faceted like the grid's own
   rule: a column is counted under every OTHER active filter, never its own, so
   its unticked options stay visible. Only the server-filterable funnels are
   counted here; line-level funnels stay counted on the loaded page. */

import type { CompanyScopeCtx } from './companyScope';
import { pageWithTruncation } from './outstanding-po-lines';
import { filterPoList, type PoListFilters } from './po-list-read';

export const PO_FACET_COLS = ['supplier', 'creditor_code', 'currency', 'po_date'] as const;
export type PoFacetCol = (typeof PO_FACET_COLS)[number];
export type PoFacets = Record<PoFacetCol, Array<[string, number]>>;

const OWN_FILTER: Record<PoFacetCol, 'creditorNames' | 'creditorCodes' | 'currencies' | 'docDates'> = {
  supplier: 'creditorNames',
  creditor_code: 'creditorCodes',
  currency: 'currencies',
  po_date: 'docDates',
};

type FacetRow = { supplier_id: string | null; po_date: string | null; currency: string | null; supplier: { name: string | null; code: string | null } | null };

/* The same keys the grid's funnel shows (PurchaseOrdersListV2 getValue +
   dataTableRows.filterKeyOf), so a server count lands on the option it names. */
function keyOf(col: PoFacetCol, r: FacetRow): string {
  const v =
    col === 'supplier' ? r.supplier?.name || r.supplier_id
    : col === 'creditor_code' ? r.supplier?.code
    : col === 'currency' ? r.currency
    : r.po_date;
  return v ? v : '—';
}

export function countFacet(rows: readonly FacetRow[], col: PoFacetCol): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(col, r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()];
}

type Sb = { from(table: string): { select(cols: string): unknown } };
type Ranged = { order(col: string, o: { ascending: boolean }): { range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> } };

export async function buildPoFacets(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: PoListFilters,
  validStatuses: ReadonlySet<string>,
): Promise<{ error: string } | { error: null; facets: PoFacets; truncated: boolean }> {
  const sb = sbIn as Sb;
  const reads = await Promise.all(
    PO_FACET_COLS.map((col) => {
      const f: PoListFilters = { ...filters, [OWN_FILTER[col]]: null };
      const creditor = (f.creditorNames?.length ?? 0) > 0 || (f.creditorCodes?.length ?? 0) > 0;
      // !inner so a creditor filter removes the PO, exactly as poListSelect does.
      const select = `po_number, supplier_id, po_date, currency, supplier:suppliers${creditor ? '!inner' : ''}(name, code)`;
      return pageWithTruncation<FacetRow>((from, to) =>
        (filterPoList(sb.from('purchase_orders').select(select), f, c, validStatuses) as unknown as Ranged)
          .order('po_number', { ascending: true })
          .range(from, to));
    }),
  );
  const failed = reads.find((r) => r.error);
  if (failed?.error) return { error: failed.error.message };
  const facets = Object.fromEntries(PO_FACET_COLS.map((col, i) => [col, countFacet(reads[i]!.data ?? [], col)])) as PoFacets;
  return { error: null, facets, truncated: reads.some((r) => r.truncated) };
}
