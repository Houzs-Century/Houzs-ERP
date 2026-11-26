
import { chunkIn } from './paginate-all';
import { pgrestInList } from './pgrest-in-list';

type ReadError = { message: string; code?: string } | null;

export type MfgProductBindingQuery = {
  codes: readonly string[];
  companyId: number | null | undefined;
  select: string;
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
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  { codes, companyId, select, supplierId }: MfgProductBindingQuery,
): Promise<{ data: T[]; error: ReadError }> {
  const wanted = [...new Set(codes.filter((c): c is string => Boolean(c)))];
  if (wanted.length === 0) return { data: [], error: null };

  return chunkIn<T>(wanted, (batch, from, to) => {
    /* NOT `.in('item_code', batch)`. supabase-js quotes a value holding `, ( )`
       and escapes nothing inside the quotes, so an item code carrying a `"` — an
       inch mark, and a mattress catalogue is full of them — closes its own quote
       early and the next `)` closes the whole `in.(` list. Every code after it in
       the batch then matches nothing, and the request answers 200. That is what
       emptied the Supplier column on 38 item codes in production; see
       lib/pgrest-in-list.ts for the measurement and docs/bugs/0780. The payload
       below is byte-identical to `.in()`'s for any batch without a `"` or `\`. */
    let q = sb
      .from('supplier_material_bindings')
      .select(select)
      .eq('material_kind', 'mfg_product')
      .filter('item_code', 'in', pgrestInList(batch));
    if (companyId != null) q = q.eq('company_id', companyId);
    if (supplierId) q = q.eq('supplier_id', supplierId);
    return q
      .order('is_main_supplier', { ascending: false })
      .order('item_code')
      .order('id')
      .range(from, to);
  });
}

/**
 * The binding an ADDED sales-order line joins an open purchase order through.
 * `bindings` is one code's rows in reader order (main supplier first), so the
 * main supplier wins whenever it already has a PO on the order; otherwise an
 * ALTERNATE bound supplier that does. HC-SO-013385/A1 (BUG-57): 9028-1NA was
 * added to a VERANO set whose PO is DORSETTLOFT, bound for that code as an
 * alternate; its main supplier (HOOKKA INDUSTRIES) had no PO there, so the line
 * reached no PO at all. Undefined = no bound supplier has a PO on the order.
 */
export function pickAddLineBinding<B extends { supplier_id: string }>(
  bindings: readonly B[],
  boundSupplierIds: ReadonlySet<string>,
): B | undefined {
  return bindings.find((b) => boundSupplierIds.has(b.supplier_id));
}
