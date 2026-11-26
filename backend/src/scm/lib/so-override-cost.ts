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
