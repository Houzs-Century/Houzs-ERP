// ----------------------------------------------------------------------------
// ONE HOME for "read the sales-order LINES the From-SO picker may offer".
//
// WHY THIS FILE EXISTS. `GET /mfg-purchase-orders/outstanding-so-items` — the
// only source the desktop From-SO picker (`PurchaseOrderFromSo.tsx`) and the
// mobile convert wizard read — asked for the whole company's live SO lines
// behind a `.limit(500)`, ordered `doc_no` DESC, and applied EVERY filter that
// decides the answer AFTERWARDS in JavaScript: the header-status gate, the hold
// gate, and the pooled MRP shortage.
//
// A cap above a later filter is not a cap on the answer — it is a cap on the
// QUESTION. This repo has now met that shape four times: MRP planning 1,000 of
// 13,918 demand rows (docs/bugs/0248), the GRN From-PO picker hiding 168 of 356
// outstanding lines (docs/bugs/0299), the same picker again (docs/bugs/0302 —
// whose own root-cause section NAMES this read as carrying the identical
// `.limit(500)` and leaves it), and here.
//
// The size that decides it is measured, not assumed: company 1 held **15,050
// live sales-order lines** on 2026-09-08 (docs/bugs/0677, run 34142505986), and
// 13,907 SO lines came in from the AutoCount cutover alone
// (docs/autocount-service-deploy.md). 500 of 15,050 is 3.3%, chosen by document
// number rather than by whether the line needs ordering — so an order outside
// that slice cannot be turned into a purchase order from the screen that exists
// to do it, and nothing on the screen says so.
//
// THE FIX IS TO PAGE, NOT TO RAISE THE NUMBER. A bigger `.limit()` is the same
// bug with a bigger wrong number, and past PostgREST's own `db-max-rows` it does
// not even move: the server hands back at most that ceiling and drops the rest
// with NO error (`lib/paginate-all.ts`). `paginateAll` walks `.range()` windows
// until a short page arrives, and its MAX_PAGES is the surviving runaway stop.
//
// THE ORDER IS TOTAL, and that is load-bearing rather than tidy. `.range()`
// windows are only coherent under a total order: `doc_no` alone is NOT unique —
// every line of one sales order shares it — so paging on `doc_no` alone can
// repeat one line across two pages and drop another. `id` breaks the tie. Same
// rule, same reason, as `lib/supplier-bindings.ts` and
// `lib/outstanding-po-lines.ts`.
// ----------------------------------------------------------------------------

import { paginateAll } from './paginate-all';

/** The column list the picker renders from. Exported so a test asserts against
 *  the shipped one rather than a copy that can drift away from it. */
export const OUTSTANDING_SO_SELECT = `
      id, doc_no, item_code, description, item_group, qty, po_qty_picked, unit_price_sen,
      variants, line_suffix, cancelled, line_delivery_date,
      so:mfg_sales_orders!inner ( doc_no, debtor_name, branding, status, on_hold, so_date, customer_delivery_date, processing_date, sales_location )
    `;

type QueryError = { message: string; code?: string } | null;

/**
 * Every non-cancelled sales-order LINE this caller may see, paged so the read
 * cannot stop early without saying so.
 *
 * `scopeQuery` is the caller's company predicate applied to the builder — the
 * route passes `(q) => scopeToCompany(q, c)`. It is a callback rather than a
 * company id because the scope helper needs the request context, and it must be
 * applied INSIDE the factory so every page carries it.
 *
 * Returns the same `{ data, error }` shape a single PostgREST call does, so the
 * caller's existing error handling is unchanged.
 */
export async function loadOutstandingSoLines<T = Record<string, unknown>>(
  // The SCM routes carry an untyped supabase-js client; matching that here
  // rather than importing a generated type keeps this usable from the route.
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  scopeQuery: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{ data: T[] | null; error: QueryError }> {
  return paginateAll<T>((from, to) =>
    scopeQuery(sb.from('mfg_sales_order_items').select(OUTSTANDING_SO_SELECT))
      .eq('cancelled', false)
      .order('doc_no', { ascending: false })
      .order('id')
      .range(from, to));
}
