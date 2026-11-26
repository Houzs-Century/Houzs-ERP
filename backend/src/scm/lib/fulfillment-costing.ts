
export function freezeShipCost(current: number | null | undefined, unitCost: number): number | undefined {
  return current == null ? unitCost : undefined;
}

export type DoLineCost = {
  qty: number | null;
  unit_cost_sen: number | null;
  line_cost_sen: number | null;
  ship_cost_sen: number | null;
};

export type SiLineCost = {
  qty: number | null;
  unit_cost_sen: number | null;
  line_cost_sen: number | null;
};

const n = (v: number | null | undefined): number => Number(v ?? 0);
const roundUnit = (line: number, qty: number): number | null => (qty > 0 ? Math.round(line / qty) : null);

export type DoAggregate = {
  present: boolean;
  qty: number;
  shipUnitSen: number | null;
  shipLineSen: number;
  liveUnitSen: number | null;
  liveLineSen: number;
  isLegacy: boolean;
};

export function aggregateDoLines(lines: DoLineCost[]): DoAggregate {
  if (lines.length === 0) {
    return { present: false, qty: 0, shipUnitSen: null, shipLineSen: 0, liveUnitSen: null, liveLineSen: 0, isLegacy: false };
  }
  let qty = 0;
  let liveLine = 0;
  let shipLine = 0;
  let anyShipNull = false;
  for (const l of lines) {
    const q = n(l.qty);
    qty += q;
    liveLine += l.line_cost_sen != null ? n(l.line_cost_sen) : n(l.unit_cost_sen) * q;
    if (l.ship_cost_sen == null) anyShipNull = true;
    else shipLine += n(l.ship_cost_sen) * q;
  }
  const liveUnit = roundUnit(liveLine, qty);
  if (anyShipNull) {
    return { present: true, qty, shipUnitSen: liveUnit, shipLineSen: liveLine, liveUnitSen: liveUnit, liveLineSen: liveLine, isLegacy: true };
  }
  return { present: true, qty, shipUnitSen: roundUnit(shipLine, qty), shipLineSen: shipLine, liveUnitSen: liveUnit, liveLineSen: liveLine, isLegacy: false };
}

export type SiAggregate = { present: boolean; qty: number; unitSen: number | null; lineSen: number };

export function aggregateSiLines(lines: SiLineCost[]): SiAggregate {
  if (lines.length === 0) return { present: false, qty: 0, unitSen: null, lineSen: 0 };
  let qty = 0;
  let line = 0;
  for (const l of lines) {
    const q = n(l.qty);
    qty += q;
    line += l.line_cost_sen != null ? n(l.line_cost_sen) : n(l.unit_cost_sen) * q;
  }
  return { present: true, qty, unitSen: roundUnit(line, qty), lineSen: line };
}

export type LineDims = {
  so_item_id: string;
  doc_no: string;
  item_code: string;
  item_name: string | null;
  category: string | null;
  customer_state: string | null;
  menu: string | null;
  qty: number;
};

export type LineComparison = LineDims & {
  order_unit_sen: number;
  order_line_sen: number;
  do_present: boolean;
  do_unit_sen: number | null;
  do_line_sen: number;
  do_cost_is_legacy: boolean;
  si_present: boolean;
  si_unit_sen: number | null;
  si_line_sen: number;
  var_do_order_sen: number | null;
  var_do_order_pct: number | null;
  var_si_do_sen: number | null;
  var_si_do_pct: number | null;
  var_si_order_sen: number | null;
  var_si_order_pct: number | null;
  pending: boolean;
  max_abs_var_pct: number;
};

const pct = (delta: number, base: number | null): number | null =>
  base != null && base !== 0 ? (delta / base) * 100 : null;

export function computeLineComparison(input: {
  dims: LineDims;
  order: { unitSen: number; lineSen: number };
  doAgg: DoAggregate;
  siAgg: SiAggregate;
}): LineComparison {
  const { dims, order, doAgg, siAgg } = input;
  const oUnit = order.unitSen;
  const dUnit = doAgg.shipUnitSen;
  const sUnit = siAgg.unitSen;

  const varDoOrder = dUnit != null ? dUnit - oUnit : null;
  const varSiDo = sUnit != null && dUnit != null ? sUnit - dUnit : null;
  const varSiOrder = sUnit != null ? sUnit - oUnit : null;

  const doOrderPct = varDoOrder != null ? pct(varDoOrder, oUnit) : null;
  const siDoPct = varSiDo != null ? pct(varSiDo, dUnit) : null;
  const siOrderPct = varSiOrder != null ? pct(varSiOrder, oUnit) : null;

  const absPcts = [doOrderPct, siDoPct].filter((p): p is number => p != null).map(Math.abs);
  const maxAbs = absPcts.length > 0 ? Math.max(...absPcts) : 0;

  return {
    ...dims,
    order_unit_sen: oUnit,
    order_line_sen: order.lineSen,
    do_present: doAgg.present,
    do_unit_sen: dUnit,
    do_line_sen: doAgg.shipLineSen,
    do_cost_is_legacy: doAgg.isLegacy,
    si_present: siAgg.present,
    si_unit_sen: sUnit,
    si_line_sen: siAgg.lineSen,
    var_do_order_sen: varDoOrder,
    var_do_order_pct: doOrderPct,
    var_si_do_sen: varSiDo,
    var_si_do_pct: siDoPct,
    var_si_order_sen: varSiOrder,
    var_si_order_pct: siOrderPct,
    pending: !siAgg.present,
    max_abs_var_pct: maxAbs,
  };
}

export type FulfilmentCostingFilterOpts = {
  minVariancePct?: number | null;
  pendingOnly?: boolean;
};

export function filterRows(rows: LineComparison[], opts: FulfilmentCostingFilterOpts): LineComparison[] {
  let out = rows;
  if (opts.pendingOnly) out = out.filter((r) => r.pending);
  if (opts.minVariancePct != null) {
    const min = opts.minVariancePct;
    out = out.filter((r) => r.max_abs_var_pct >= min);
  }
  return out;
}

export type CostingSummary = {
  lines: number;
  order_cost_sen: number;
  do_cost_sen: number;
  si_cost_sen: number;
  variance_sen: number;
  variance_pct: number | null;
  pending_count: number;
  legacy_count: number;
};

export function summarize(rows: LineComparison[]): CostingSummary {
  let order = 0;
  let doC = 0;
  let si = 0;
  let pending = 0;
  let legacy = 0;
  for (const r of rows) {
    order += r.order_line_sen;
    doC += r.do_line_sen;
    si += r.si_line_sen;
    if (r.pending) pending += 1;
    if (r.do_cost_is_legacy) legacy += 1;
  }
  const variance = si - order;
  return {
    lines: rows.length,
    order_cost_sen: order,
    do_cost_sen: doC,
    si_cost_sen: si,
    variance_sen: variance,
    variance_pct: order !== 0 ? (variance / order) * 100 : null,
    pending_count: pending,
    legacy_count: legacy,
  };
}

export type CostingDimension = 'item' | 'category' | 'menu' | 'state';

/* ── Category case collision (owner-reported 2026-07-19) ──────────────────────
 * Observed live: this report rendered NINE category groups for Houzs, six of
 * which were case-variant pairs of each other — `bedframe` (6 lines) alongside
 * `BEDFRAME` (10 lines), `mattress`/`MATTRESS`, `accessory`/`ACCESSORY` — each
 * half reporting its own partial cost and variance, with nothing on screen
 * saying so. Every per-category cost and margin figure was a fraction.
 *
 * Mechanism, from the code: this dimension reads `mfg_sales_order_items
 * .item_group`, which is plain `text` — no enum, no FK, no check constraint.
 * Two writers disagree about case. The product-driven path lowercases the
 * enum (`String(prod.category ?? 'others').toLowerCase()`, mfg-sales-orders.ts),
 * while client-supplied lines pass `it.itemGroup` straight through, so an
 * import or a caller echoing the UPPERCASE `mfg_product_category` enum value
 * stores it verbatim. Same taxonomy, two spellings, one unconstrained column.
 *
 * The five enum members correspond 1:1 with the five lowercase slugs, so
 * case-folding them is a merge of genuinely identical concepts, not a guess.
 * `others` is the one value with NO enum counterpart: it is synthesised at
 * write time when the product lookup misses, and it is also the SO line
 * editor's default for a fresh row. It is a FALLBACK, not a category — hence
 * the explicit label below, so nobody reads it as a product family.
 *
 * Fixed at the READ layer only. The stored values are left exactly as they
 * are: rewriting `item_group` on existing rows is a data migration, needs
 * staging first and the owner's sign-off, and is not decided here. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  sofa: 'Sofa',
  bedframe: 'Bedframe',
  mattress: 'Mattress',
  accessory: 'Accessory',
  service: 'Service',
  others: 'Others (uncategorised)',
};

/** Escape the LIKE metacharacters so a value can be handed to `ilike` and mean
 *  "equals, ignoring case" instead of "matches this pattern". Without it a
 *  category containing `%` or `_` would silently match unrelated rows. */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

/** Case/whitespace-fold a stored `item_group` into one stable bucket key.
 *  Returns '' for a missing value so it still groups under "Unspecified". */
export function normaliseCategoryKey(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Display name for a folded category key. Known values get a fixed spelling
 *  so the group heading no longer inherits whichever case happened to be
 *  stored first; anything unrecognised is shown verbatim rather than hidden. */
export function categoryLabel(raw: string | null | undefined): string {
  const key = normaliseCategoryKey(raw);
  if (!key) return 'Unspecified';
  return CATEGORY_LABELS[key] ?? String(raw).trim();
}

/** The group key + human label for a row under a chosen dimension. A missing
 *  value groups under a stable '' key labelled "Unspecified" rather than being
 *  dropped — an un-stated state or category is itself an answer worth seeing. */
export function dimensionKeyLabel(row: LineComparison, dim: CostingDimension): { key: string; label: string } {
  switch (dim) {
    case 'item':     return { key: row.item_code, label: row.item_name ? `${row.item_code} — ${row.item_name}` : row.item_code };
    case 'category': return { key: normaliseCategoryKey(row.category), label: categoryLabel(row.category) };
    case 'menu':     return { key: row.menu ?? '', label: row.menu ?? 'Unspecified' };
    case 'state':    return { key: row.customer_state ?? '', label: row.customer_state ?? 'Unspecified' };
  }
}

export type CostingGroup = CostingSummary & { key: string; label: string };

export function groupRows(rows: LineComparison[], dim: CostingDimension): CostingGroup[] {
  const buckets = new Map<string, { label: string; rows: LineComparison[] }>();
  for (const r of rows) {
    const { key, label } = dimensionKeyLabel(r, dim);
    let b = buckets.get(key);
    if (!b) { b = { label, rows: [] }; buckets.set(key, b); }
    b.rows.push(r);
  }
  return [...buckets.entries()]
    .map(([key, b]) => ({ key, label: b.label, ...summarize(b.rows) }))
    .sort((a, z) => Math.abs(z.variance_sen) - Math.abs(a.variance_sen));
}
