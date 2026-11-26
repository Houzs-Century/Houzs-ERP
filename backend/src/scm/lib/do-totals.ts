
import { isServiceLine } from '../shared';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the SCM libs */
export async function recomputeDoTotals(sb: any, deliveryOrderId: string): Promise<void> {
  const { data: items, error: itemsErr } = await sb.from('delivery_order_items')
    .select('item_code, item_group, line_total_sen, line_cost_sen')
    .eq('delivery_order_id', deliveryOrderId);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[do-recompute] item read failed — header left unchanged:', deliveryOrderId, itemsErr.message);
    return;
  }
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, service = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0, serviceCost = 0;
  for (const it of (items ?? []) as Array<{ item_code: string | null; item_group: string | null; line_total_sen: number | null; line_cost_sen: number | null }>) {
    const lineTotal = Number(it.line_total_sen ?? 0);
    const lineCost  = Number(it.line_cost_sen ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (isServiceLine({ itemGroup: g, itemCode: it.item_code })) { service += lineTotal; serviceCost += lineCost; }
    else if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  const { error: updErr } = await sb.from('delivery_orders').update({
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    service_sen: service,
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen: bedframeCost,
    accessories_cost_sen: accessoriesCost,
    others_cost_sen: othersCost,
    service_cost_sen: serviceCost,
    local_total_sen: total,
    total_cost_sen: totalCost,
    total_margin_sen: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    updated_at: new Date().toISOString(),
  }).eq('id', deliveryOrderId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[do-recompute] header update failed — totals left STALE:', deliveryOrderId, updErr.message);
  }
}
