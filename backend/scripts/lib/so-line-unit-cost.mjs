/** The product cost for one sales order line, current (not as-of). SOFA reads the
 *  seat grid PRICE_2 cost at the ordered height; everything else the flat cost lane.
 *  A sofa line with no height on it still has a cost when every height of the
 *  model costs the same (owner 2026-11-04: 8030-1A is RM 700 at 24" and 28", so the
 *  order need not name one). Heights that cost differently stay 0: picking one
 *  would be a guess at the margin. */
export function unitCostSen(p, variants) {
  if (!p) return 0;
  const cat = String(p.category || '').toUpperCase();
  if (cat === 'SOFA' && Array.isArray(p.seat_height_prices)) {
    const grid = p.seat_height_prices.filter((e) => (e.tier ?? 'PRICE_2') === 'PRICE_2' && Number(e.priceSen) > 0);
    const h = variants?.seatHeight ?? variants?.seat_height ?? null;
    if (h != null) {
      const hh = String(h).replace(/"/g, '');
      const hit = grid.find((e) => String(e.height) === hh);
      if (hit) return Number(hit.priceSen);
    } else {
      const costs = new Set(grid.map((e) => Number(e.priceSen)));
      if (costs.size === 1) return [...costs][0];
    }
  }
  return Number(p.base_price_sen) || Number(p.cost_price_sen) || 0;
}
