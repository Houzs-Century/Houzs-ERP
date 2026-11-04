const heightOf = (variants) => variants?.seatHeight ?? variants?.seat_height ?? variants?.depth ?? null;
const clean = (h) => String(h).replace(/"/g, '').trim();

/** The model of a code: 9058-1B(LHF) -> 9058. */
const modelOf = (code) => String(code).split('-')[0];

/** The height each SKU, then each model, sells at most, from the height counts of
 *  the lines that named one: [{ item_code, height, n }]. A tie takes the smaller
 *  height, so the same counts always give the same answer. */
export function usualHeights(rows) {
  const tally = new Map();
  const add = (key, h, n) => {
    const m = tally.get(key) ?? new Map();
    m.set(h, (m.get(h) ?? 0) + n);
    tally.set(key, m);
  };
  for (const r of rows) {
    if (r.height == null || clean(r.height) === '') continue;
    add(`sku:${r.item_code}`, clean(r.height), Number(r.n) || 0);
    add(`model:${modelOf(r.item_code)}`, clean(r.height), Number(r.n) || 0);
  }
  const usual = new Map();
  for (const [key, m] of tally) {
    usual.set(key, [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))[0][0]);
  }
  return usual;
}

/** The product cost for one sales order line, current (not as-of). SOFA reads the
 *  seat grid PRICE_2 cost at the ordered height; everything else the flat cost lane.
 *  A line that names no height takes the one cost all heights share, else the cost
 *  at the height this SKU, then this model, sells at most (owner 2026-11-04: with
 *  nothing chosen, cost it as the usual variant). Colour never moves the cost, so
 *  height is the only variant read. With no sales to go by it stays 0. */
export function unitCostSen(p, variants, usual) {
  if (!p) return 0;
  const cat = String(p.category || '').toUpperCase();
  if (cat === 'SOFA' && Array.isArray(p.seat_height_prices)) {
    const grid = p.seat_height_prices.filter((e) => (e.tier ?? 'PRICE_2') === 'PRICE_2' && Number(e.priceSen) > 0);
    const at = (h) => grid.find((e) => String(e.height) === h);
    const h = heightOf(variants);
    if (h != null) {
      const hit = at(clean(h));
      if (hit) return Number(hit.priceSen);
    } else {
      const costs = new Set(grid.map((e) => Number(e.priceSen)));
      if (costs.size === 1) return [...costs][0];
      const hit = at(usual.get(`sku:${p.code}`)) ?? at(usual.get(`model:${modelOf(p.code)}`));
      if (hit) return Number(hit.priceSen);
    }
  }
  return Number(p.base_price_sen) || Number(p.cost_price_sen) || 0;
}
