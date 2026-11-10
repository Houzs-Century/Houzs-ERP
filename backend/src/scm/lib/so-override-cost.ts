/* The line cost a Sales Order price override recomputes its margin from.
 *
 * A FAILED read is not a zero cost: margin = new total - 0 books the whole price
 * as profit. So the result says which it was, and the override route refuses
 * (before its audit insert) instead of guessing. lib/failed-read-refusal.ts. */
type PgError = { message?: string | null } | null;

export async function readOverrideLineCost(
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- the route's untyped client
  itemId: string,
): Promise<{ ok: true; costSen: number } | { ok: false; error: PgError }> {
  const { data, error } = await sb.from('mfg_sales_order_items')
    .select('line_cost_sen')
    .eq('id', itemId)
    .maybeSingle();
  if (error) return { ok: false, error };
  return { ok: true, costSen: Number((data as { line_cost_sen?: number } | null)?.line_cost_sen ?? 0) };
}
