/* From-scratch PO: the supplier's flat cost is the price in force on the PO
   date, from supplier_binding_price_history. No row on or before the date means
   the current binding price (a binding with no history keeps working). Pure. */

export type PriceHistoryRow = {
  item_code: string;
  effective_from: string;
  created_at: string;
  unit_price_sen: number | null;
  price_matrix: unknown;
};

export function bindingAsOf<B extends { item_code: string; unit_price_sen: number; price_matrix?: unknown }>(
  binding: B,
  history: readonly PriceHistoryRow[],
  asOf: string,
): B {
  let best: PriceHistoryRow | null = null;
  for (const r of history) {
    if (r.item_code !== binding.item_code || r.effective_from > asOf) continue;
    if (!best || r.effective_from > best.effective_from
      || (r.effective_from === best.effective_from && r.created_at > best.created_at)) best = r;
  }
  if (!best) return binding;
  return { ...binding, unit_price_sen: best.unit_price_sen ?? binding.unit_price_sen, price_matrix: best.price_matrix ?? null };
}
