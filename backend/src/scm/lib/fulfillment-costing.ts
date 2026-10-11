// ----------------------------------------------------------------------------
// fulfillment-costing.ts — the PURE cost-math originally written for the
// standalone Finance > Fulfillment Costing report.
//
// STATUS 2026-07-19: the Fulfillment Costing module (page + nav + endpoint) was
// REMOVED as redundant — the Sales Report (fka Fair Report) already carries the
// three-way SO→DO→Invoice cost comparison. This file is KEPT because
// `freezeShipCost` (the freeze-at-ship money-path half) is still imported by
// routes/delivery-orders-mfg.ts, and mig 0143's ship_cost_centi snapshot feeds
// the Sales Report's DO-stage cost. The report-math exports below
// (aggregate*/computeLineComparison/filterRows/summarize/groupRows) no longer
// have a route caller; they remain pinned by tests/fulfillmentCosting.test.ts.
//
// WHY A SEPARATE PURE MODULE: the report's whole reason to exist is a THREE-WAY
// cost comparison per Sales Order line —
//   ① Order-time cost  (mfg_sales_order_items.*_cost_centi, the SO estimate),
//   ② DO ship-time FIFO (delivery_order_items.ship_cost_centi, frozen at ship),
//   ③ SI landed cost    (sales_invoice_items.*_cost_centi, the store-card cost
//                        after the supplier PI lands and recost cascades).
// Getting the fall-backs, the "legacy" flag and the variances right is the
// entire correctness surface, and it is money. The codebase tests money by
// extracting a PURE function and pinning it (services/agents/order-fulfilment.ts
// is the model), NOT by mocking Supabase — so every decision that could be wrong
// lives here as a plain function the route calls and the tests exercise.
//
// UNITS: every *_centi value is an integer number of cents (1/100 of MYR). Unit
// costs are per-piece; line costs are unit*qty. Variances are compared on UNIT
// cost, which is qty-independent and therefore honest across partial deliveries
// / partial invoicing (an SO line can be split over several DOs, a DO over
// several SIs). Percentages are plain numbers (e.g. 12.5 == 12.5%).
// ----------------------------------------------------------------------------

/* ── The freeze decision (the money-path half) ──────────────────────────────
   restampDoActualCost overwrites delivery_order_items.unit_cost_centi IN PLACE
   every time it runs — at ship, at line-set change, and (via recost.ts) when a
   supplier PI lands. That in-place overwrite is exactly what collapses ② into ③
   after a PI, destroying the three-way split. ship_cost_centi (mig 0143) is the
   snapshot that survives it: freeze the ship-time FIFO unit cost ONCE, the first
   time a DO is costed after shipping (ship_cost_centi still NULL), and NEVER
   overwrite it — so a later recost re-running the same path leaves the frozen ②
   untouched. Returning `undefined` means "do not write the column", which keeps
   the freeze idempotent by construction rather than by a caller remembering to
   guard. */
export function freezeShipCost(current: number | null | undefined, unitCost: number): number | undefined {
  return current == null ? unitCost : undefined;
}

// ── Aggregation inputs (one raw table row each) ─────────────────────────────
export type DoLineCost = {
  qty: number | null;
  unit_cost_centi: number | null;   // live/landed unit cost (recost overwrites this)
  line_cost_centi: number | null;   // live/landed line cost
  ship_cost_centi: number | null;   // frozen ship-time FIFO unit cost; NULL on legacy DOs
};

export type SiLineCost = {
  qty: number | null;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
};

const n = (v: number | null | undefined): number => Number(v ?? 0);
const roundUnit = (line: number, qty: number): number | null => (qty > 0 ? Math.round(line / qty) : null);

// ── ② DO aggregate ──────────────────────────────────────────────────────────
export type DoAggregate = {
  present: boolean;
  qty: number;
  /** ② unit cost — the ship-time FIFO cost when it was frozen, else the live
   *  cost as a documented fall-back. */
  shipUnitCenti: number | null;
  shipLineCenti: number;
  /** The live/landed value on the DO line right now (== ③ after a PI recost). */
  liveUnitCenti: number | null;
  liveLineCenti: number;
  /** TRUE when ≥1 delivering DO line has no frozen ship_cost_centi, so ② had to
   *  fall back to the live cost. These are DOs shipped-and-recosted BEFORE mig
   *  0143 existed: their true ship-time ② is gone and ②≈③ is a legacy limit, not
   *  real convergence. The report must LABEL these rows so the owner knows. */
  isLegacy: boolean;
};

export function aggregateDoLines(lines: DoLineCost[]): DoAggregate {
  if (lines.length === 0) {
    return { present: false, qty: 0, shipUnitCenti: null, shipLineCenti: 0, liveUnitCenti: null, liveLineCenti: 0, isLegacy: false };
  }
  let qty = 0;
  let liveLine = 0;
  let shipLine = 0;
  let anyShipNull = false;
  for (const l of lines) {
    const q = n(l.qty);
    qty += q;
    // line_cost_centi is authoritative when present; unit*qty is the fall-back
    // for a row the writer only stamped a unit cost onto.
    liveLine += l.line_cost_centi != null ? n(l.line_cost_centi) : n(l.unit_cost_centi) * q;
    if (l.ship_cost_centi == null) anyShipNull = true;
    else shipLine += n(l.ship_cost_centi) * q;
  }
  const liveUnit = roundUnit(liveLine, qty);
  // Any legacy line taints the whole SO-line aggregate — mixing a frozen unit
  // with a live one would fabricate a ② that never existed, so fall the ENTIRE
  // line back to live and flag it, rather than silently blend.
  if (anyShipNull) {
    return { present: true, qty, shipUnitCenti: liveUnit, shipLineCenti: liveLine, liveUnitCenti: liveUnit, liveLineCenti: liveLine, isLegacy: true };
  }
  return { present: true, qty, shipUnitCenti: roundUnit(shipLine, qty), shipLineCenti: shipLine, liveUnitCenti: liveUnit, liveLineCenti: liveLine, isLegacy: false };
}

// ── ③ SI aggregate ──────────────────────────────────────────────────────────
export type SiAggregate = { present: boolean; qty: number; unitCenti: number | null; lineCenti: number };

export function aggregateSiLines(lines: SiLineCost[]): SiAggregate {
  if (lines.length === 0) return { present: false, qty: 0, unitCenti: null, lineCenti: 0 };
  let qty = 0;
  let line = 0;
  for (const l of lines) {
    const q = n(l.qty);
    qty += q;
    line += l.line_cost_centi != null ? n(l.line_cost_centi) : n(l.unit_cost_centi) * q;
  }
  return { present: true, qty, unitCenti: roundUnit(line, qty), lineCenti: line };
}

// ── Per-line three-way comparison ───────────────────────────────────────────
export type LineDims = {
  so_item_id: string;
  doc_no: string;
  item_code: string;
  item_name: string | null;
  category: string | null;      // item_group
  customer_state: string | null;
  /** "Menu" grouping — DEFAULT = product model (owner has not defined "Menu";
   *  see the route). Held as a plain label resolved by the route. */
  menu: string | null;
  qty: number;
};

export type LineComparison = LineDims & {
  order_unit_centi: number;
  order_line_centi: number;
  do_present: boolean;
  do_unit_centi: number | null;   // ②
  do_line_centi: number;
  do_cost_is_legacy: boolean;
  si_present: boolean;
  si_unit_centi: number | null;   // ③
  si_line_centi: number;
  // Variances on UNIT cost (qty-independent). *_pct relative to the earlier
  // stage; null when the earlier stage is 0/absent (a pct off zero is a lie).
  var_do_order_centi: number | null;
  var_do_order_pct: number | null;
  var_si_do_centi: number | null;
  var_si_do_pct: number | null;
  var_si_order_centi: number | null;
  var_si_order_pct: number | null;
  /** No landed (③) cost booked yet — the supplier PI half of the store-card
   *  cost has not arrived, so ③ is still pending. Definition: no SI line bills
   *  this SO line yet. */
  pending: boolean;
  /** Largest absolute stage-to-stage variance %, for the "variance > X%" filter. */
  max_abs_var_pct: number;
};

const pct = (delta: number, base: number | null): number | null =>
  base != null && base !== 0 ? (delta / base) * 100 : null;

export function computeLineComparison(input: {
  dims: LineDims;
  order: { unitCenti: number; lineCenti: number };
  doAgg: DoAggregate;
  siAgg: SiAggregate;
}): LineComparison {
  const { dims, order, doAgg, siAgg } = input;
  const oUnit = order.unitCenti;
  const dUnit = doAgg.shipUnitCenti;
  const sUnit = siAgg.unitCenti;

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
    order_unit_centi: oUnit,
    order_line_centi: order.lineCenti,
    do_present: doAgg.present,
    do_unit_centi: dUnit,
    do_line_centi: doAgg.shipLineCenti,
    do_cost_is_legacy: doAgg.isLegacy,
    si_present: siAgg.present,
    si_unit_centi: sUnit,
    si_line_centi: siAgg.lineCenti,
    var_do_order_centi: varDoOrder,
    var_do_order_pct: doOrderPct,
    var_si_do_centi: varSiDo,
    var_si_do_pct: siDoPct,
    var_si_order_centi: varSiOrder,
    var_si_order_pct: siOrderPct,
    pending: !siAgg.present,
    max_abs_var_pct: maxAbs,
  };
}

// ── Filters (server-side, mirror the mockup's controls) ─────────────────────
export type FulfilmentCostingFilterOpts = {
  /** Keep only rows whose largest stage-to-stage variance is at least this %. */
  minVariancePct?: number | null;
  /** Keep only rows with no landed (③) cost yet. */
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

// ── Summary strip (the 5 tiles) + grouping ──────────────────────────────────
export type CostingSummary = {
  lines: number;
  order_cost_centi: number;
  do_cost_centi: number;
  si_cost_centi: number;
  variance_centi: number;   // ③ − ① on LINE cost (landed vs order estimate)
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
    order += r.order_line_centi;
    doC += r.do_line_centi;
    si += r.si_line_centi;
    if (r.pending) pending += 1;
    if (r.do_cost_is_legacy) legacy += 1;
  }
  const variance = si - order;
  return {
    lines: rows.length,
    order_cost_centi: order,
    do_cost_centi: doC,
    si_cost_centi: si,
    variance_centi: variance,
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
    // Folded — see the block comment above. The key is the fold so the two
    // spellings land in one bucket; the label is the canonical spelling.
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
    // Biggest absolute landed-vs-order variance first — the rows a finance
    // reviewer wants at the top.
    .sort((a, z) => Math.abs(z.variance_centi) - Math.abs(a.variance_centi));
}
