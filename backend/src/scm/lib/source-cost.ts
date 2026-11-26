
import { chunkIn } from './paginate-all';

/**
 * Map every given source line id -> its stored `unit_cost_sen`.
 *
 * `table` is the SOURCE line table (delivery_order_items /
 * consignment_sales_order_items / consignment_delivery_order_items). Ids that
 * no longer exist are simply absent from the map, so a caller falls back to its
 * own default rather than silently booking 0.
 *
 * `sb` is the loosely-typed Supabase client from the Hono context.
 */
export async function sourceUnitCostByItemId(
  sb: any,
  table: string,
  ids: Array<string | null | undefined>,
  companyId: number | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return out;
  const { data } = await chunkIn<{ id: string; unit_cost_sen: number | null }>(
    wanted,
    (batch, from, to) => {
      let q = sb.from(table).select('id, unit_cost_sen').in('id', batch);
      if (companyId != null) q = q.eq('company_id', companyId);
      return q.range(from, to);
    },
  );
  for (const r of (data ?? []) as Array<{ id: string; unit_cost_sen: number | null }>) {
    out.set(r.id, Number(r.unit_cost_sen ?? 0));
  }
  return out;
}
