// ----------------------------------------------------------------------------
// ONE HOME for "read the mfg-product supplier bindings for these item codes".
//
// WHY THIS FILE EXISTS. Six places in this tree ask that same question, and on
// 2026-08-16 exactly ONE of them was taught how to ask it safely. `routes/mrp.ts`
// section 5 was fixed after 2,660 binding rows in production met a 1,000-row
// response cap and roughly two thirds of them never arrived — the SKUs they
// belonged to rendered "— none —" on the MRP page, which is the difference
// between a row staff can convert to a purchase order and a row they cannot.
// The fix was chunk the IN-list, page the result, and order it TOTALLY. It was
// applied at that one call site and nowhere else.
//
// The other five kept the original shape, and two of them are on the path the
// operator takes NEXT, from that very page:
//
//   · routes/mfg-purchase-orders.ts — the SO→PO picker's "Main Supplier" column,
//     which renders the same "— none —" from a read over EVERY code in the
//     picker;
//   · the same file's convert body, where a binding that does not arrive is not
//     a blank cell but a 400: the SKU is reported back as `missing_bindings`,
//     i.e. the operator is told a bound SKU "isn't bound to a supplier yet".
//
// THREE THINGS THIS DOES, and each of them is load-bearing:
//
//   1. CHUNKS the `.in()` list by URL bytes (chunkIn) — an unbounded IN-list is
//      a refused request at the edge, not a slow query (see paginate-all.ts on
//      the ~19.5KB that was observed refused in production).
//   2. PAGES each chunk — PostgREST hands back at most `max-rows` (1000) and
//      reports NOTHING about the remainder. A `.limit()` does not lift it.
//   3. Orders TOTALLY — `is_main_supplier DESC` first, because every caller
//      takes the first row it sees per code as that code's main supplier, then
//      `item_code, id` so the order is total and `.range()` windows are
//      coherent. Without the tie-break, ties come back in whatever order the
//      planner produced: the callers' "first row wins" rule is then a coin
//      toss, and any truncation cuts in an arbitrary place — which is how two
//      of three identically-bound sofa modules can disagree on screen.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';

/** A PostgREST error as the callers already handle it. */
type ReadError = { message: string; code?: string } | null;

export type MfgProductBindingQuery = {
  /** The item codes to resolve. Duplicates are fine; the read de-dupes. */
  codes: readonly string[];
  /** Active company, or null/undefined for the no-scoping (single-company) case. */
  companyId: number | null | undefined;
  /** The PostgREST `select` list — each caller needs different columns. */
  select: string;
  /** Narrow to ONE supplier's bindings (the append-to-PO pricing path). */
  supplierId?: string | null;
};

/**
 * Every `material_kind = 'mfg_product'` binding for `codes`, chunked and paged
 * so neither the request nor the response can be silently clipped, ordered
 * `is_main_supplier DESC, item_code, id`.
 *
 * Returns the same `{ data, error }` shape a single PostgREST call does, so a
 * caller's existing error handling is unchanged. `data` is never null — on
 * failure it carries whatever arrived before the first failing chunk, exactly
 * as `chunkIn` has always behaved.
 */
export async function readMfgProductBindings<T = Record<string, unknown>>(
  // The SCM routes carry an untyped supabase-js client; matching that here
  // rather than importing a generated type keeps this usable from every caller.
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  { codes, companyId, select, supplierId }: MfgProductBindingQuery,
): Promise<{ data: T[]; error: ReadError }> {
  const wanted = [...new Set(codes.filter((c): c is string => Boolean(c)))];
  if (wanted.length === 0) return { data: [], error: null };

  return chunkIn<T>(wanted, (batch, from, to) => {
    let q = sb
      .from('supplier_material_bindings')
      .select(select)
      .eq('material_kind', 'mfg_product')
      .in('item_code', batch);
    if (companyId != null) q = q.eq('company_id', companyId);
    if (supplierId) q = q.eq('supplier_id', supplierId);
    return q
      .order('is_main_supplier', { ascending: false })
      .order('item_code')
      .order('id')
      .range(from, to);
  });
}
