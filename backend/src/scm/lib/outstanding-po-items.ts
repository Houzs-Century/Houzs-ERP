/**
 * The read behind the GRN-from-PO picker (`GET /outstanding-po-items`).
 *
 * Lives here rather than inline in the route because the route file is at its
 * size ceiling — and because the defect below was in the READ, which a route
 * handler with a Hono context is awkward to test and this is not.
 *
 * TRUNCATION FIX 2026-08-17 — the owner could not convert HC-PO-2608-001 to a
 * goods received note. The purchase order showed two lines at Ordered 1 /
 * Received 0 / Balance 1; the picker said every line had been received. The
 * read was `.order('purchase_order_id', { ascending: false }).limit(500)` with
 * BOTH filters applied afterwards in JavaScript, and `purchase_order_id` is a
 * UUID — so the ordering is arbitrary rather than newest-first and the 500 was
 * an arbitrary SAMPLE of the company's PO lines, spent mostly on lines that
 * were never candidates. Measured against production: 875 PO lines for HOUZS,
 * 356 genuinely outstanding, and the picker could see 188 of them. Full
 * numbers and the two theories the probe ruled out: docs/modules/grn.md §9.
 *
 * Three properties this must keep. `outstanding-po-items.test.ts` pins each:
 *
 *  1. THE STATUS FILTER IS IN THE QUERY. The embed is `!inner`, so a filter on
 *     it drops the top-level row too — that is what bounds the read to open
 *     work as purchase_order_items grows without bound.
 *  2. NO `.limit()`. `paginateAll` reads every page, because PostgREST caps a
 *     response at 1000 rows whatever `.limit()` asks for and drops the rest
 *     with NO error. A bigger number only moves the same silent truncation.
 *  3. THE SORT IS A TOTAL ORDER. Every line of one PO shares
 *     `purchase_order_id`, so `id` breaks the tie; a PAGED read over a
 *     non-unique sort key can repeat or skip rows across a page boundary.
 */
import { paginateAll } from './paginate-all';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';

/** A PO line plus the parent header fields the picker groups and locks by. */
export type OutstandingPoItemRow = {
  id: string; purchase_order_id: string; material_kind: string; material_code: string;
  material_name: string; supplier_sku: string | null; item_group: string | null; description: string | null;
  /* NULLABLE, and the type has to say so. The column is nullable in the
     database, and typing it `number` here would make the `?? 0` guards below
     and in the route read as redundant to the linter — which is how a real
     guard gets deleted. */
  qty: number; received_qty: number | null; unit_price_centi: number;
  warehouse_id: string | null; variants: unknown; delivery_date: string | null;
  // Migration 0180 — per-line supplier-revised delivery dates.
  supplier_delivery_date_2: string | null;
  supplier_delivery_date_3: string | null;
  supplier_delivery_date_4: string | null;
  po: {
    id: string; po_number: string; supplier_id: string; status: string;
    po_date: string; expected_at: string | null; purchase_location_id: string | null;
    // Migration 0180 — header supplier-revised delivery dates.
    supplier_delivery_date_2: string | null;
    supplier_delivery_date_3: string | null;
    supplier_delivery_date_4: string | null;
    supplier: { code: string; name: string } | null;
  };
};

/* Commander 2026-05-29 — the picker locks to ONE warehouse per GRN and shows a
   Warehouse column, so the parent's purchase_location_id is selected here; the
   warehouse code/name is resolved in a second round trip by the caller
   (Supabase nested selects can't reach warehouses through the items→po hop). */
const SELECT = `
  id, purchase_order_id, material_kind, material_code, material_name, supplier_sku, item_group,
  description, qty, received_qty, unit_price_centi, warehouse_id, variants, delivery_date,
  supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
  po:purchase_orders!inner ( id, po_number, supplier_id, status, po_date, expected_at,
    supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
    purchase_location_id, supplier:suppliers ( code, name ) )
`;

/** The slice of the PostgREST builder this read touches, spelled out instead of
 *  taken as `any`. A `sb: any` is precisely what lets a hand-written row type
 *  promise non-null over a nullable column, and the linter then calls the only
 *  surviving guard redundant — see received_qty above. */
type PoItemsQuery = {
  eq(col: string, val: unknown): PoItemsQuery;
  in(col: string, vals: readonly (string | number)[]): PoItemsQuery;
  order(col: string, opts: { ascending: boolean }): PoItemsQuery;
  range(from: number, to: number): PromiseLike<{
    data: unknown[] | null;
    error: { message: string; code?: string } | null;
  }>;
};
export type OutstandingPoItemsClient = {
  from(table: string): { select(columns: string): PoItemsQuery };
};

/**
 * Every PO line still awaiting receipt in the caller's active company.
 *
 * `openStatuses` is REQUIRED, not defaulted: it decides which documents are
 * still receivable, and a caller that says nothing must not silently inherit
 * someone else's answer. Pass `RECEIVABLE_PO_STATUSES` from routes/grns.ts —
 * that handler used to carry its own hand-written copy of the same pair.
 *
 * Cross-company leak fix (owner 2026-08-10, "为什么 houzs 的数据进到去 2990"):
 * this read returned EVERY company's outstanding lines until scopeToCompany
 * was wrapped around it. Items carry company_id since mig 0083, and the scope
 * FAILS CLOSED when the company context cannot resolve — so an empty result is
 * never on its own evidence that the work is done, which is why GrnFromPo's
 * empty state may not say so.
 */
export async function fetchOutstandingPoItems(
  sb: OutstandingPoItemsClient,
  c: CompanyScopeCtx,
  openStatuses: readonly string[],
): Promise<{ data: OutstandingPoItemRow[] | null; error: { message: string } | null }> {
  const { data, error } = await paginateAll((from, to) =>
    scopeToCompany(sb.from('purchase_order_items').select(SELECT), c)
      .in('po.status', [...openStatuses])
      .order('purchase_order_id', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) return { data: null, error };

  /* The one filter that CANNOT move into the statement: it compares two
     COLUMNS, and PostgREST has no filter for that. */
  const rows = ((data ?? []) as unknown as OutstandingPoItemRow[])
    .filter((r) => r.qty - (r.received_qty ?? 0) > 0);
  return { data: rows, error: null };
}
