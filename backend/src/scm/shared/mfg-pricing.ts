
export type MfgPricedOption = {
  value:    string;
  priceSen: number;
  costSen?: number;
  /** SELLING surcharge authored by the Sales Director (POS Maintenance,
   *  PR #257). This — not `priceSen` — is what `computeMfgLinePrice` adds to
   *  the customer-facing line total. Unset today everywhere, so variant
   *  surcharges contribute 0 to selling until a director sets a real value
   *  (Commander 2026-05-28: "这些价钱都是 costing，不是卖价"). */
  sellingPriceSen?: number;
  /** Owner spec 2026-06-12 — inactive options are hidden from NEW-entry
   *  pickers only. Cost/selling lookups below intentionally IGNORE this flag
   *  so documents that already carry the value keep resolving. */
  active?: boolean;
};
import type { MaintPoolEntry } from './maintenance-pools';
export type MaintenanceConfig = {
  divanHeights:   MfgPricedOption[];
  legHeights:     MfgPricedOption[];
  totalHeights:   MfgPricedOption[];
  gaps:           MaintPoolEntry[];
  specials:       MfgPricedOption[];
  sofaLegHeights: MfgPricedOption[];
  sofaSpecials:   MfgPricedOption[];
  sofaSizes:      MaintPoolEntry[];
};

/** Fabric tier — same enum HOOKKA stores on fabric_trackings. PRICE_3 is a
 *  forward-compat slot; current Commander rules only switch on PRICE_1. */
export type MfgFabricTier = 'PRICE_1' | 'PRICE_2' | 'PRICE_3' | 'PRICE_4';

/** Per-(height, tier) sofa price entry. Legacy rows without `tier` are
 *  treated as PRICE_2 (HOOKKA's historic default).
 *  `priceSen` = COST (read by computeMfgLineCost; NEVER the buyer price).
 *  `sellingPriceSen` = the buyer (SELLING) price the POS Master-Admin grid
 *  authors (decision 6).
 *  Both are optional so an entry can be cost-only (Backend), selling-only (a POS
 *  grid price for a slot Backend hasn't costed), or both. resolveSeatHeightSen
 *  skips entries with no `priceSen` (never fabricates a 0 cost from a selling-only
 *  row); resolveSeatHeightSelling skips entries with no `sellingPriceSen`. */
export type MfgSeatHeightPrice = {
  height: string;
  priceSen?: number;
  tier?: MfgFabricTier;
  sellingPriceSen?: number;
};

/** Minimal product shape the compute function needs. Caller projects
 *  whatever DB row they have (mfgProducts row, MfgProductRow query type,
 *  hand-built test fixture) into this. */
export type MfgPricingProduct = {
  category: 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE';
  basePriceSen: number | null;
  price1Sen?: number | null;
  seatHeightPrices?: MfgSeatHeightPrice[] | null;
  seatHeightCosts?: MfgSeatHeightPrice[] | null;
  costPriceSen?: number | null;
  cost1Sen?: number | null;
};

/** Caller passes a resolved fabric tier (PRICE_1 / PRICE_2 / PRICE_3) +
 *  optional flat surcharge on top. The tier is read by the SoLineCard /
 *  API code from fabric_trackings — split per context: sofa_price_tier for
 *  SOFA, bedframe_price_tier for BEDFRAME. */
export type MfgPricingFabric = {
  tier: MfgFabricTier | null;
  surchargeSen?: number;
  costAddSen?: number;
};

export type MfgPricingInput = {
  product:        MfgPricingProduct;
  fabric?:        MfgPricingFabric | null;
  qty:            number;
  divanHeight?:   string | null;
  legHeight?:     string | null;
  totalHeight?:   string | null;
  specials?:      string[];
  seatSize?:      string | null;
  sofaLegHeight?: string | null;
};

/** Result mirrors the HOOKKA 5-component breakdown plus the fabric add-on.
 *  Sen integers throughout — match the schema's `*_sen` / `*_sen`
 *  conventions (1 sen = 1 cent of MYR). */
export type MfgPricingBreakdown = {
  basePriceSen:               number;
  divanSurchargeSen:          number;
  legSurchargeSen:            number;
  totalHeightSurchargeSen:    number;
  specialsSurchargeSen:       number;
  fabricSurchargeSen:         number;
  unitPriceSen:               number;
  lineTotalSen:               number;
  source: 'PRICE_1' | 'PRICE_2' | 'BASE_ONLY';
};

const sum = (...n: number[]): number => n.reduce((a, b) => a + b, 0);

const QUOTE_MAP: Record<string, string> = {
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', 'ʺ': '"',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", 'ʹ': "'",
};
/** Fold typographic quote/prime characters onto their ASCII equivalents. */
export const normaliseTypographicQuotes = (s: string): string =>
  s.replace(/[‘’‚‛“”„‟′″ʹʺ]/g, (c) => QUOTE_MAP[c] ?? c);

const findOption = (
  pool: MfgPricedOption[],
  value: string,
): MfgPricedOption | undefined => {
  const exact = pool.find((o) => o.value === value);
  if (exact) return exact;
  const wanted = normaliseTypographicQuotes(value);
  return pool.find((o) => normaliseTypographicQuotes(o.value) === wanted);
};

const lookupCost = (
  pool: MfgPricedOption[] | undefined,
  value: string | null | undefined,
): number => {
  if (!pool || !value) return 0;
  const hit = findOption(pool, value);
  if (!hit) return 0;
  return hit.priceSen ?? hit.costSen ?? 0;
};

const lookupSelling = (
  pool: MfgPricedOption[] | undefined,
  value: string | null | undefined,
): number => {
  if (!pool || !value) return 0;
  const hit = findOption(pool, value);
  return hit?.sellingPriceSen ?? 0;
};

const sumSpecialsSelling = (
  pool: MfgPricedOption[] | undefined,
  picks: string[] | undefined,
): number => {
  if (!pool || !picks || picks.length === 0) return 0;
  let total = 0;
  for (const p of picks) {
    const hit = findOption(pool, p);
    if (hit) total += hit.sellingPriceSen ?? 0;
  }
  return total;
};

const sumSpecialsCost = (
  pool: MfgPricedOption[] | undefined,
  picks: string[] | undefined,
): number => {
  if (!pool || !picks || picks.length === 0) return 0;
  let total = 0;
  for (const p of picks) {
    const hit = findOption(pool, p);
    if (hit) total += hit.priceSen ?? hit.costSen ?? 0;
  }
  return total;
};

export type SpecialAddonChoiceDef = { label: string; extraSen: number };
export type SpecialAddonGroupDef = { label: string; required?: boolean; choices: SpecialAddonChoiceDef[] };
/** "Detect by compartment" (2990 owner 2026-10-26): the add-on's price when the
 *  sofa build carries this compartment — e.g. a Latex Seat costs more on a build
 *  with a corner (CNR). SELLING only, like a choice's extraSen. */
export type SpecialAddonCompartmentPriceDef = { compartment: string; sellingPriceSen: number };
export type SpecialAddonDef = {
  code: string;
  sellingPriceSen: number;
  costPriceSen?: number;
  optionGroups?: SpecialAddonGroupDef[];
  compartmentPrices?: SpecialAddonCompartmentPriceDef[];
};

/** The add-on's base SELLING price for one sofa build. A compartment price
 *  replaces the base when the build carries that compartment; when several
 *  match, the highest wins (the rule of the per-compartment fabric prices). No
 *  build, no compartment prices or no match → the add-on's own base. Codes
 *  compare exactly, so pass canonical codes (sofa-build normalizeCompartmentCode)
 *  — this module imports nothing, so it cannot normalize them itself. */
export function specialAddonBaseSellingSen(
  def: Pick<SpecialAddonDef, 'sellingPriceSen' | 'compartmentPrices'>,
  buildCompartments: readonly string[] | null,
): number {
  const rows = def.compartmentPrices ?? [];
  if (rows.length === 0 || !buildCompartments || buildCompartments.length === 0) return def.sellingPriceSen;
  const built = new Set(buildCompartments);
  let best: number | null = null;
  for (const r of rows) {
    if (!built.has(r.compartment) || !Number.isFinite(r.sellingPriceSen)) continue;
    if (best === null || r.sellingPriceSen > best) best = r.sellingPriceSen;
  }
  return best ?? def.sellingPriceSen;
}

/** Build the per-line specials pool (MfgPricedOption[]) from special_addons defs
 *  + the line's picked codes + chosen choice labels (code → [labels]). Each
 *  entry's `sellingPriceSen` = base (specialAddonBaseSellingSen: a matched
 *  compartment price, else the add-on's own) + Σ matched choice `extraSen`;
 *  `priceSen` (cost) = the add-on's cost base (choices and compartment prices
 *  are selling-only). Picks with no matching def resolve to 0 (tolerant —
 *  mirrors the engine's lookup). Feed the result in as maintenanceConfig
 *  .specials / .sofaSpecials for that line. `buildCompartments` = the line's
 *  sofa build compartment codes; null when the line has no build (bedframe,
 *  mattress, a sofa without cells). */
export function buildSpecialsPoolFromAddons(
  defs: SpecialAddonDef[] | null | undefined,
  picks: string[] | null | undefined,
  choices: Record<string, string[]> | null | undefined,
  buildCompartments: readonly string[] | null,
): MfgPricedOption[] {
  if (!picks || picks.length === 0) return [];
  const byCode = new Map((defs ?? []).map((d) => [d.code, d]));
  return picks.map((code) => {
    const def = byCode.get(code);
    if (!def) return { value: code, priceSen: 0, sellingPriceSen: 0 };
    let selling = specialAddonBaseSellingSen(def, buildCompartments);
    for (const label of choices?.[code] ?? []) {
      for (const g of def.optionGroups ?? []) {
        const hit = g.choices.find((c) => c.label === label);
        if (hit) { selling += hit.extraSen; break; }
      }
    }
    return { value: code, priceSen: def.costPriceSen ?? 0, sellingPriceSen: selling };
  });
}

/** Client preview convenience: total SELLING surcharge (sen) for the picked
 *  add-ons + choices — Σ of the pool's sellingPriceSen. The POS configurator
 *  adds this to the line's live total so it matches the server recompute. */
export function specialAddonsSurchargeSen(
  defs: SpecialAddonDef[] | null | undefined,
  picks: string[] | null | undefined,
  choices: Record<string, string[]> | null | undefined,
  buildCompartments: readonly string[] | null,
): number {
  return buildSpecialsPoolFromAddons(defs, picks, choices, buildCompartments)
    .reduce((acc, o) => acc + (o.sellingPriceSen ?? 0), 0);
}

/** Resolve the seat-height price for the picked (size, tier). Falls back
 *  to the PRICE_2 entry, then to the first entry. Returns `{ priceSen,
 *  matchedTier }` so the caller can label `source` accurately even on a
 *  tier fallback. Returns null when the array is empty / undefined so the
 *  caller can fall back to basePriceSen. */
export const resolveSeatHeightSen = (
  rows: MfgSeatHeightPrice[] | null | undefined,
  size: string | null | undefined,
  tier: MfgFabricTier | null | undefined,
): { priceSen: number; matchedTier: MfgFabricTier } | null => {
  if (!rows || rows.length === 0 || !size) return null;
  const wantTier: MfgFabricTier = tier ?? 'PRICE_2';
  const normalize = (t: MfgFabricTier | undefined): MfgFabricTier => t ?? 'PRICE_2';
  const costed = (r: MfgSeatHeightPrice): r is MfgSeatHeightPrice & { priceSen: number } =>
    r.priceSen != null;
  const exact = rows.find((r) => r.height === size && normalize(r.tier) === wantTier && costed(r));
  if (exact) return { priceSen: exact.priceSen!, matchedTier: wantTier };
  const fallback = rows.find((r) => r.height === size && normalize(r.tier) === 'PRICE_2' && costed(r));
  if (fallback) return { priceSen: fallback.priceSen!, matchedTier: 'PRICE_2' };
  const any = rows.find((r) => r.height === size && costed(r));
  return any ? { priceSen: any.priceSen!, matchedTier: normalize(any.tier) } : null;
};

/** SELLING-side sibling of resolveSeatHeightSen. Reads `.sellingPriceSen` for
 *  the picked (size, tier) with an exact→PRICE_2-default fallback, SKIPPING any
 *  row whose `sellingPriceSen` is null/undefined. Returns null (caller falls
 *  through to the flat module sell_price_sen) when no priced selling row matches
 *  the picked tier OR the PRICE_2 default.
 *
 *  Deliberately NO blind any-tier fallback (unlike the cost resolver): the
 *  buyer must never be silently charged a DIFFERENT fabric tier's selling price
 *  (honest-pricing brand promise). A want with no exact and no PRICE_2-default
 *  selling row resolves to null, not to "whatever tier happens to be priced".
 *  Never leaks `priceSen`/cost into the buyer price. */
export const resolveSeatHeightSelling = (
  rows: MfgSeatHeightPrice[] | null | undefined,
  size: string | null | undefined,
  tier: MfgFabricTier | null | undefined,
): { sellingPriceSen: number; matchedTier: MfgFabricTier } | null => {
  if (!rows || rows.length === 0 || !size) return null;
  const wantTier: MfgFabricTier = tier ?? 'PRICE_2';
  const normalize = (t: MfgFabricTier | undefined): MfgFabricTier => t ?? 'PRICE_2';
  const priced = (r: MfgSeatHeightPrice): r is MfgSeatHeightPrice & { sellingPriceSen: number } =>
    r.sellingPriceSen != null;
  const exact = rows.find((r) => r.height === size && normalize(r.tier) === wantTier && priced(r));
  if (exact) return { sellingPriceSen: exact.sellingPriceSen!, matchedTier: wantTier };
  const fallback = rows.find((r) => r.height === size && normalize(r.tier) === 'PRICE_2' && priced(r));
  if (fallback) return { sellingPriceSen: fallback.sellingPriceSen!, matchedTier: 'PRICE_2' };
  return null;
};

/** Compute the unit-price breakdown for one mfg SO line. Pure — no I/O,
 *  no DB, safe to import in both Workers and React. */
export function computeMfgLinePrice(
  input: MfgPricingInput,
  maintenanceConfig: MaintenanceConfig | null,
): MfgPricingBreakdown {
  const { product, fabric, qty } = input;
  const tier: MfgFabricTier | null = fabric?.tier ?? null;
  const fabricSurchargeSen = Math.max(0, fabric?.surchargeSen ?? 0);

  const basePriceSen = 0;
  let source: MfgPricingBreakdown['source'] = 'BASE_ONLY';

  if (product.category === 'SOFA') {
    const seat = resolveSeatHeightSen(product.seatHeightPrices, input.seatSize, tier);
    source = seat != null
      ? (seat.matchedTier === 'PRICE_1' ? 'PRICE_1' : 'PRICE_2')
      : (tier === 'PRICE_1' && product.price1Sen != null && product.price1Sen > 0 ? 'PRICE_1' : 'PRICE_2');
  } else if (product.category === 'BEDFRAME') {
    source = tier === 'PRICE_1' && product.price1Sen != null && product.price1Sen > 0 ? 'PRICE_1' : 'PRICE_2';
  } else {
    source = 'BASE_ONLY';
  }

  let divanSurchargeSen       = 0;
  let legSurchargeSen         = 0;
  let totalHeightSurchargeSen = 0;
  let specialsSurchargeSen    = 0;

  if (maintenanceConfig && product.category === 'BEDFRAME') {
    divanSurchargeSen       = lookupSelling(maintenanceConfig.divanHeights, input.divanHeight);
    legSurchargeSen         = lookupSelling(maintenanceConfig.legHeights, input.legHeight);
    totalHeightSurchargeSen = lookupSelling(maintenanceConfig.totalHeights, input.totalHeight);
    specialsSurchargeSen    = sumSpecialsSelling(maintenanceConfig.specials, input.specials);
  } else if (maintenanceConfig && product.category === 'SOFA') {
    legSurchargeSen      = lookupSelling(maintenanceConfig.sofaLegHeights, input.sofaLegHeight ?? input.legHeight);
    specialsSurchargeSen = sumSpecialsSelling(maintenanceConfig.sofaSpecials, input.specials);
  } else if (maintenanceConfig && product.category === 'MATTRESS') {
    specialsSurchargeSen = sumSpecialsSelling(maintenanceConfig.specials, input.specials);
  }

  const unitPriceSen = sum(
    basePriceSen,
    divanSurchargeSen,
    legSurchargeSen,
    totalHeightSurchargeSen,
    specialsSurchargeSen,
    fabricSurchargeSen,
  );

  const safeQty   = Math.max(0, Math.floor(qty));
  const lineTotal = unitPriceSen * safeQty;

  return {
    basePriceSen,
    divanSurchargeSen,
    legSurchargeSen,
    totalHeightSurchargeSen,
    specialsSurchargeSen,
    fabricSurchargeSen,
    unitPriceSen,
    lineTotalSen: lineTotal,
    source,
  };
}

/** Cost-side compute. Commander 2026-05-28 definitive model: the backend
 *  maintenance price tables (`priceSen`) ARE the cost. So this mirrors what
 *  `computeMfgLinePrice` did BEFORE PR #265 — the product's base price fields
 *  (`basePriceSen` / `price1Sen` / `seatHeightPrices[].priceSen`) as the base
 *  cost, plus the sum of each option's `priceSen` surcharge. On backend these
 *  values ARE the cost the commander entered.
 *
 *  `costPriceSen` / `cost1Sen` / `costSen` (the abandoned PR #216 cost fields)
 *  are consulted only as a per-field fallback when the corresponding
 *  `basePriceSen` / `price1Sen` / `priceSen` is absent — so a half-migrated
 *  config still yields a cost rather than a hard 0. The fabric add-on uses
 *  `costAddSen` when present, else the selling flat `surchargeSen`. */
export function computeMfgLineCost(
  input: MfgPricingInput,
  maintenanceConfig: MaintenanceConfig | null,
): MfgPricingBreakdown {
  const { product, fabric, qty } = input;
  const tier: MfgFabricTier | null = fabric?.tier ?? null;
  const fabricAddSen = Math.max(0, fabric?.costAddSen ?? fabric?.surchargeSen ?? 0);

  let baseCostSen = 0;
  let source: MfgPricingBreakdown['source'] = 'BASE_ONLY';

  if (product.category === 'SOFA') {
    const seat = resolveSeatHeightSen(product.seatHeightPrices, input.seatSize, tier)
      ?? resolveSeatHeightSen(product.seatHeightCosts ?? null, input.seatSize, tier);
    if (seat != null) {
      baseCostSen = seat.priceSen;
      source = seat.matchedTier === 'PRICE_1' ? 'PRICE_1' : 'PRICE_2';
    } else if (tier === 'PRICE_1' && product.price1Sen != null && product.price1Sen > 0) {
      baseCostSen = product.price1Sen;
      source = 'PRICE_1';
    } else {
      baseCostSen = product.basePriceSen ?? product.costPriceSen ?? 0;
      source = 'PRICE_2';
    }
  } else if (product.category === 'BEDFRAME') {
    if (tier === 'PRICE_1' && product.price1Sen != null && product.price1Sen > 0) {
      baseCostSen = product.price1Sen;
      source = 'PRICE_1';
    } else {
      baseCostSen = product.basePriceSen ?? product.costPriceSen ?? 0;
      source = 'PRICE_2';
    }
  } else {
    baseCostSen = product.basePriceSen ?? product.costPriceSen ?? 0;
    source = 'BASE_ONLY';
  }

  let divanSurchargeSen       = 0;
  let legSurchargeSen         = 0;
  let totalHeightSurchargeSen = 0;
  let specialsSurchargeSen    = 0;

  if (maintenanceConfig && product.category === 'BEDFRAME') {
    divanSurchargeSen       = lookupCost(maintenanceConfig.divanHeights, input.divanHeight);
    legSurchargeSen         = lookupCost(maintenanceConfig.legHeights, input.legHeight);
    totalHeightSurchargeSen = lookupCost(maintenanceConfig.totalHeights, input.totalHeight);
    specialsSurchargeSen    = sumSpecialsCost(maintenanceConfig.specials, input.specials);
  } else if (maintenanceConfig && product.category === 'SOFA') {
    legSurchargeSen      = lookupCost(maintenanceConfig.sofaLegHeights, input.sofaLegHeight ?? input.legHeight);
    specialsSurchargeSen = sumSpecialsCost(maintenanceConfig.sofaSpecials, input.specials);
  } else if (maintenanceConfig && product.category === 'MATTRESS') {
    specialsSurchargeSen = sumSpecialsCost(maintenanceConfig.specials, input.specials);
  }

  const unitCostSen = sum(
    baseCostSen,
    divanSurchargeSen,
    legSurchargeSen,
    totalHeightSurchargeSen,
    specialsSurchargeSen,
    fabricAddSen,
  );
  const safeQty   = Math.max(0, Math.floor(qty));
  const lineTotal = unitCostSen * safeQty;

  return {
    basePriceSen: baseCostSen,
    divanSurchargeSen,
    legSurchargeSen,
    totalHeightSurchargeSen,
    specialsSurchargeSen,
    fabricSurchargeSen: fabricAddSen,
    unitPriceSen: unitCostSen,
    lineTotalSen: lineTotal,
    source,
  };
}


/** Raw price_matrix as it arrives off the binding row (JSONB). Bedframe =
 *  `{P1?,P2?}` (sen); sofa = `{ "<seatSize>": {P1?,P2?,P3?,P4?} }` (sen). Null on
 *  rows / categories that use the flat `unit_price_sen`
 *  (mattress / accessory / service). */
export type PoPriceMatrix = Record<string, unknown> | null;

const asSen = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Project a supplier binding's `price_matrix` + flat fallback into the
 *  `MfgPricingProduct` shape that `computeMfgLineCost` understands, then
 *  delegate. Pure — no I/O, safe in Workers and React.
 *
 *  - BEDFRAME: basePriceSen = matrix.P2; price1Sen = matrix.P1. When BOTH are
 *    missing → basePriceSen = `unitPriceSen` (flat fallback).
 *  - SOFA: build seatHeightPrices from each `[size, cell]` — one row per
 *    populated tier (P2→PRICE_2, P1→PRICE_1, P3→PRICE_3, P4→PRICE_4). basePriceSen =
 *    `unitPriceSen` so `computeMfgLineCost` falls back to flat when the
 *    matrix is empty / the picked seat size isn't found.
 *  - MATTRESS / ACCESSORY / SERVICE: basePriceSen = `unitPriceSen`.
 *
 *  Tier handling (P2 default, P1 only on PRICE_1 + P1 present) lives inside
 *  `computeMfgLineCost`; we just pass `fabricTier` through. */
export function computeMfgPoUnitCost(
  input: {
    category: 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE';
    priceMatrix: PoPriceMatrix;
    unitPriceSen: number;
    fabricTier?: MfgFabricTier | null;
    qty?: number;
    seatSize?: string | null;
    divanHeight?: string | null;
    legHeight?: string | null;
    totalHeight?: string | null;
    sofaLegHeight?: string | null;
    specials?: string[];
  },
  maintenanceConfig: MaintenanceConfig | null,
): MfgPricingBreakdown {
  const matrix =
    input.priceMatrix && typeof input.priceMatrix === 'object'
      ? (input.priceMatrix as Record<string, unknown>)
      : null;

  let product: MfgPricingProduct;

  if (input.category === 'BEDFRAME') {
    const p2 = matrix ? asSen(matrix.P2) : null;
    const p1 = matrix ? asSen(matrix.P1) : null;
    product = {
      category:     'BEDFRAME',
      basePriceSen: p2 ?? (p1 == null ? input.unitPriceSen : null),
      price1Sen:    p1,
    };
  } else if (input.category === 'SOFA') {
    const seatHeightPrices: MfgSeatHeightPrice[] = [];
    if (matrix) {
      for (const [size, raw] of Object.entries(matrix)) {
        if (!raw || typeof raw !== 'object') continue;
        const cell = raw as Record<string, unknown>;
        const p2 = asSen(cell.P2);
        const p1 = asSen(cell.P1);
        const p3 = asSen(cell.P3);
        const p4 = asSen(cell.P4);
        if (p2 != null) seatHeightPrices.push({ height: size, tier: 'PRICE_2', priceSen: p2 });
        if (p1 != null) seatHeightPrices.push({ height: size, tier: 'PRICE_1', priceSen: p1 });
        if (p3 != null) seatHeightPrices.push({ height: size, tier: 'PRICE_3', priceSen: p3 });
        if (p4 != null) seatHeightPrices.push({ height: size, tier: 'PRICE_4', priceSen: p4 });
      }
    }
    product = {
      category:     'SOFA',
      basePriceSen: input.unitPriceSen,
      seatHeightPrices: seatHeightPrices.length > 0 ? seatHeightPrices : null,
    };
  } else {
    product = { category: input.category, basePriceSen: input.unitPriceSen };
  }

  return computeMfgLineCost(
    {
      product,
      fabric:        { tier: input.fabricTier ?? null },
      qty:           input.qty ?? 1,
      seatSize:      input.seatSize ?? null,
      divanHeight:   input.divanHeight ?? null,
      legHeight:     input.legHeight ?? null,
      totalHeight:   input.totalHeight ?? null,
      sofaLegHeight: input.sofaLegHeight ?? null,
      specials:      input.specials,
    },
    maintenanceConfig,
  );
}

/** True when the client-submitted unit price drifts more than 0.5% from
 *  the server-computed unit price. Mirrors `pricingDriftExceeds` in
 *  pricing.ts but operates on `*_sen` integers directly. */
export const mfgPricingDriftExceeds = (
  clientUnitPriceSen: number,
  serverUnitPriceSen: number,
): boolean => {
  if (serverUnitPriceSen <= 0) return clientUnitPriceSen !== 0;
  const drift = Math.abs(clientUnitPriceSen - serverUnitPriceSen) / serverUnitPriceSen;
  return drift > 0.005;
};
