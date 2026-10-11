// ----------------------------------------------------------------------------
// Manufacturing (B2B) SO line pricing — single source of truth.
//
// Ported from HOOKKA's src/lib/pricing.ts (5 additive components) and
// extended with the Commander 2026-05-27 finalised rules:
//
//   Sofa      = seatHeightPrices[seatSize, fabricTier] + sofaLegSurcharge
//               + sofaSpecialsSurcharge   (+ optional fabric surcharge)
//   Bedframe  = (price1Sen if fabricTier=PRICE_1 else basePriceSen)
//               + divanSurcharge + legSurcharge + totalHeightSurcharge
//               + specialsSurcharge       (+ optional fabric surcharge)
//   Mattress  = basePriceSen   (no variants, no fabric tier)
//   Accessory = basePriceSen   (no variants)
//
// TotalHeight is ADDITIVE on top of divan+leg (HOOKKA precedent). Gaps are
// dimensional configuration with NO price contribution.
//
// Pure: zero React imports, zero DB calls. Server (apps/api) and client
// (apps/backend) both import this — see the "Server-side pricing recompute"
// non-negotiable in 2990s-readonly/CLAUDE.md.
//
// Cost-side: parallel `computeMfgLineCost` mirrors the SAME additive shape,
// but Commander 2026-05-28's definitive model says the backend maintenance
// price tables (`priceSen`) ARE the cost. So cost = product base price
// (basePriceSen / price1Sen / seatHeightPrices[].priceSen) + Σ option
// `priceSen` surcharges — exactly what `computeMfgLinePrice` did BEFORE
// PR #265 split selling onto `sellingPriceSen`. `costSen` is kept only as a
// per-option fallback (a half-migrated config still yields a cost rather than
// 0). `computeMfgLineCost` is wired into the API `unit_cost_centi` snapshot on
// SO create/update (recomputeFromSnapshot → mfg-sales-orders route).
// ----------------------------------------------------------------------------

/* MaintenanceConfig — same JSON shape that's stored in
 * maintenance_config_history.config (db/schema.ts:2160) and surfaced to
 * the client via apps/backend/src/lib/mfg-products-queries.ts. We declare
 * it locally so @2990s/shared does not pull in @2990s/db (one-way: shared
 * → consumers). The `costSen` extension on each priced option is opt-in
 * for the parallel cost compute below. */
export type MfgPricedOption = {
  value:    string;
  /** COST benchmark (commander's mental model: Backend `priceSen` = the
   *  purchase / cost reference, NOT the customer-facing selling surcharge).
   *  Read by `computeMfgLineCost`. NEVER summed into the selling total. */
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
/** String-pool entry — plain string (= active) or { value, active }.
 *  See @2990s/shared maintenance-pools.ts. */
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
export type MfgFabricTier = 'PRICE_1' | 'PRICE_2' | 'PRICE_3';

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
  /** PRICE_2 / default. Single-source for mattress/accessory; bedframe
   *  fallback when fabric tier resolves to PRICE_2 (or fabric not picked). */
  basePriceSen: number | null;
  /** PRICE_1 / cheaper tier. Only consulted when fabric tier = PRICE_1
   *  AND the product opts in (some bedframes only carry PRICE_2). */
  price1Sen?: number | null;
  /** Sofa-only: per-(height, tier) prices. When `tier` is missing on a
   *  row we treat it as PRICE_2. */
  seatHeightPrices?: MfgSeatHeightPrice[] | null;
  /** Sofa-only cost-side parallel. Falls back to `costPriceSen`. */
  seatHeightCosts?: MfgSeatHeightPrice[] | null;
  /** PRICE_2 cost. Mattress/accessory single source. */
  costPriceSen?: number | null;
  /** PRICE_1 cost. Same opt-in rule as price1Sen. */
  cost1Sen?: number | null;
};

/** Caller passes a resolved fabric tier (PRICE_1 / PRICE_2 / PRICE_3) +
 *  optional flat surcharge on top. The tier is read by the SoLineCard /
 *  API code from fabric_trackings — split per context: sofa_price_tier for
 *  SOFA, bedframe_price_tier for BEDFRAME. */
export type MfgPricingFabric = {
  tier: MfgFabricTier | null;
  /** Optional flat add-on (Fabric pool surcharge — commander said "if you
   *  use the Fabric pool"). Defaults to 0 when absent. */
  surchargeSen?: number;
  /** Same for cost-side: lets a fabric carry its own cost-add too. */
  costAddSen?: number;
};

export type MfgPricingInput = {
  product:        MfgPricingProduct;
  fabric?:        MfgPricingFabric | null;
  qty:            number;
  /** Bedframe variant selections (value strings, exactly as keyed in
   *  MaintenanceConfig.{divanHeights,legHeights,totalHeights}). */
  divanHeight?:   string | null;
  legHeight?:     string | null;
  totalHeight?:   string | null;
  /** Bedframe AND sofa: multi-pick specials. */
  specials?:      string[];
  /** Sofa-only: seat size (string, matches MaintenanceConfig.sofaSizes
   *  entry — e.g. '24', '28'). When omitted we fall back to basePriceSen
   *  (legacy sofa rows that haven't populated seat_height_prices yet). */
  seatSize?:      string | null;
  /** Sofa-only: leg height (matches sofaLegHeights). */
  sofaLegHeight?: string | null;
};

/** Result mirrors the HOOKKA 5-component breakdown plus the fabric add-on.
 *  Sen integers throughout — match the schema's `*_sen` / `*_centi`
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
  /** PRICE_1 means we used product.price1Sen (or PRICE_1 seat row);
   *  PRICE_2 means basePriceSen (or PRICE_2 seat row);
   *  BASE_ONLY = mattress / accessory / no-tier fallback. */
  source: 'PRICE_1' | 'PRICE_2' | 'BASE_ONLY';
};

const sum = (...n: number[]): number => n.reduce((a, b) => a + b, 0);

/* ─── Typographic quotes ──────────────────────────────────────────────────
   THE INCH MARK IS TYPED THREE DIFFERENT WAYS AND THEY ARE DIFFERENT STRINGS.
   Every pool value here is compared with `===`, so `18"` (U+0022) and `18“`
   (U+201C, what a phone keyboard or a paste from Word produces) are simply two
   unrelated keys. Measured on prod 2026-08-17: 2990's live totalHeights pool
   carries `17“`, `19“`, `25”` and `27“` alongside straight-quoted `18"` and
   `26"`, and one document line stores its gap as `12“`. A line whose spelling
   does not match the pool's silently prices the surcharge at 0 — the same
   failure mode as the missing `totalHeight` argument, arriving by a different
   road.

   NORMALISATION IS A FALLBACK, NEVER A REPLACEMENT, and that ordering is the
   whole safety argument. An exact hit is always preferred, so no line that
   already matches can be re-priced by this change — including the pools that
   carry the SAME height twice under different spellings and DIFFERENT prices
   (supplier 07204b99 has `19“` at both RM40 and RM120). Only a value that
   matches nothing today — and therefore prices at 0 today — can start matching.

   Deliberately narrow: quote characters only. No trim, no case folding. Those
   would be a second, unrelated behaviour change hiding inside a typography fix,
   and this same string family also composes `variant_key`, which is the
   inventory bucket identity. */
const QUOTE_MAP: Record<string, string> = {
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', 'ʺ': '"',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", 'ʹ': "'",
};
/** Fold typographic quote/prime characters onto their ASCII equivalents. */
export const normaliseTypographicQuotes = (s: string): string =>
  s.replace(/[‘’‚‛“”„‟′″ʹʺ]/g, (c) => QUOTE_MAP[c] ?? c);

/** Exact match first; only then a quote-insensitive one. Returns undefined when
 *  neither finds anything, exactly as `find` did. */
const findOption = (
  pool: MfgPricedOption[],
  value: string,
): MfgPricedOption | undefined => {
  const exact = pool.find((o) => o.value === value);
  if (exact) return exact;
  const wanted = normaliseTypographicQuotes(value);
  return pool.find((o) => normaliseTypographicQuotes(o.value) === wanted);
};

/** COST surcharge lookup (Commander 2026-05-28 definitive model). Backend
 *  maintenance `priceSen` IS the cost, so the cost compute reads `priceSen`
 *  (mirroring what `computeMfgLinePrice` did before PR #265). `costSen` is
 *  honoured only as a fallback when the option carries no `priceSen` — so a
 *  half-migrated config still produces a cost rather than 0. Selling-side
 *  `sellingPriceSen` is never consulted here. */
const lookupCost = (
  pool: MfgPricedOption[] | undefined,
  value: string | null | undefined,
): number => {
  if (!pool || !value) return 0;
  const hit = findOption(pool, value);
  if (!hit) return 0;
  return hit.priceSen ?? hit.costSen ?? 0;
};

/** Selling-side surcharge lookup. Commander 2026-05-28: variant `priceSen`
 *  is COST, NOT selling — so the customer-facing line total must read the
 *  Sales-Director-authored `sellingPriceSen` instead. Falls back to 0 when
 *  the option carries no selling surcharge (the case today: surcharges
 *  contribute 0 to selling until a director sets a value). */
const lookupSelling = (
  pool: MfgPricedOption[] | undefined,
  value: string | null | undefined,
): number => {
  if (!pool || !value) return 0;
  const hit = findOption(pool, value);
  return hit?.sellingPriceSen ?? 0;
};

/** Sum N specials against a single pool on the SELLING side — reads each
 *  option's `sellingPriceSen` (the Sales-Director-authored selling surcharge,
 *  NOT the `priceSen` cost benchmark). Unknown picks contribute 0 (matches
 *  HOOKKA's tolerant behaviour); picks with no selling surcharge set also
 *  contribute 0, which is the case across the board today. */
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

/** Sum N specials on the COST side. Reads each option's `priceSen` (the
 *  backend cost), falling back to `costSen` per option when `priceSen` is
 *  absent. Mirrors `lookupCost`. */
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

/* ─── Special Add-ons (migration 0134) — shared pool builder ──────────────
 * The POS configurator price preview AND the server recompute both build the
 * per-SO-line specials pool from the special_addons table via the SAME pure
 * function below, so client and server always agree (no drift). The existing
 * computeMfgLinePrice/Cost engine is UNCHANGED — it reads maintenanceConfig
 * .specials / .sofaSpecials as before; callers just pass a pool built here
 * (each entry's sellingPriceSen already bakes in base + chosen-choice extras). */
export type SpecialAddonChoiceDef = { label: string; extraSen: number };
export type SpecialAddonGroupDef = { label: string; required?: boolean; choices: SpecialAddonChoiceDef[] };
export type SpecialAddonDef = {
  code: string;
  sellingPriceSen: number;
  costPriceSen?: number;
  optionGroups?: SpecialAddonGroupDef[];
};

/** Build the per-line specials pool (MfgPricedOption[]) from special_addons defs
 *  + the line's picked codes + chosen choice labels (code → [labels]). Each
 *  entry's `sellingPriceSen` = base + Σ matched choice `extraSen`; `priceSen`
 *  (cost) = the add-on's cost base (choices are selling-only). Picks with no
 *  matching def resolve to 0 (tolerant — mirrors the engine's lookup). Feed the
 *  result in as maintenanceConfig.specials / .sofaSpecials for that line. */
export function buildSpecialsPoolFromAddons(
  defs: SpecialAddonDef[] | null | undefined,
  picks: string[] | null | undefined,
  choices: Record<string, string[]> | null | undefined,
): MfgPricedOption[] {
  if (!picks || picks.length === 0) return [];
  const byCode = new Map((defs ?? []).map((d) => [d.code, d]));
  return picks.map((code) => {
    const def = byCode.get(code);
    if (!def) return { value: code, priceSen: 0, sellingPriceSen: 0 };
    let selling = def.sellingPriceSen;
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
): number {
  return buildSpecialsPoolFromAddons(defs, picks, choices)
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
  // Only consider rows that actually carry a cost. A selling-only row (priceSen
  // unset, sellingPriceSen set by the POS grid) must NOT be read as a 0 cost —
  // skipping it lets cost fall through to basePriceSen, identical to no-entry.
  const costed = (r: MfgSeatHeightPrice): r is MfgSeatHeightPrice & { priceSen: number } =>
    r.priceSen != null;
  // Try exact (height + tier).
  const exact = rows.find((r) => r.height === size && normalize(r.tier) === wantTier && costed(r));
  if (exact) return { priceSen: exact.priceSen!, matchedTier: wantTier };
  // PRICE_2 row for this height (commander: PRICE_2 is the default).
  const fallback = rows.find((r) => r.height === size && normalize(r.tier) === 'PRICE_2' && costed(r));
  if (fallback) return { priceSen: fallback.priceSen!, matchedTier: 'PRICE_2' };
  // Any costed row for this height.
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

  // ── BASE PRICE (SELLING) ─────────────────────────────────────────────
  // Commander 2026-05-29 (system-wide): the product price tables
  // (`basePriceSen` / `price1Sen` / `seatHeightPrices[].priceSen`) represent
  // COST (what suppliers charge us), NOT the customer-facing selling price.
  // So the SELLING base must NEVER auto-populate from those fields — it is
  // operator-authored on the SO line and defaults to 0. We deliberately do
  // NOT read product.basePriceSen / price1Sen / seatHeightPrices here.
  //
  // The COST side (`computeMfgLineCost` below) is UNCHANGED — it still reads
  // those product price fields as the cost base, so unit_cost_centi /
  // line_margin_centi keep working exactly as before.
  //
  // `source` still labels the tier the SELLING surcharges would resolve under
  // (sofa seat row / bedframe price tier) so the breakdown shape is preserved.
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
    // MATTRESS / ACCESSORY / SERVICE — single-price per SKU.
    source = 'BASE_ONLY';
  }

  // ── SURCHARGES (per category, from maintenance config) ───────────────
  let divanSurchargeSen       = 0;
  let legSurchargeSen         = 0;
  let totalHeightSurchargeSen = 0;
  let specialsSurchargeSen    = 0;

  // Commander 2026-05-28: variant surcharges on the SELLING total must come
  // from `sellingPriceSen` (Sales-Director-authored), NOT `priceSen` — the
  // latter is the COST benchmark and must never inflate the customer-facing
  // line. With `sellingPriceSen` unset everywhere today, every surcharge
  // below resolves to 0, exactly the behaviour the commander wants. Real
  // selling surcharges appear here only once a director sets them.
  if (maintenanceConfig && product.category === 'BEDFRAME') {
    divanSurchargeSen       = lookupSelling(maintenanceConfig.divanHeights, input.divanHeight);
    legSurchargeSen         = lookupSelling(maintenanceConfig.legHeights, input.legHeight);
    totalHeightSurchargeSen = lookupSelling(maintenanceConfig.totalHeights, input.totalHeight);
    specialsSurchargeSen    = sumSpecialsSelling(maintenanceConfig.specials, input.specials);
  } else if (maintenanceConfig && product.category === 'SOFA') {
    // No divan / total height on sofa. sofaLegHeight is the sofa-side pool.
    legSurchargeSen      = lookupSelling(maintenanceConfig.sofaLegHeights, input.sofaLegHeight ?? input.legHeight);
    specialsSurchargeSen = sumSpecialsSelling(maintenanceConfig.sofaSpecials, input.specials);
  } else if (maintenanceConfig && product.category === 'MATTRESS') {
    // Special Add-ons (migration 0134) can target MATTRESS too. No height/leg
    // surcharges for mattress — only the special add-ons. The server patches
    // maintenanceConfig.specials with this line's special_addons pool, so read it.
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
  // Cost fabric add-on: prefer the cost-specific add, else the selling flat
  // surcharge (commander's "if you use the Fabric pool" — same pool, cost-side).
  const fabricAddSen = Math.max(0, fabric?.costAddSen ?? fabric?.surchargeSen ?? 0);

  let baseCostSen = 0;
  let source: MfgPricingBreakdown['source'] = 'BASE_ONLY';

  if (product.category === 'SOFA') {
    // Base cost = seat-height priceSen per commander's model; fall back to the
    // cost-side seat rows / flat columns only when no selling seat row exists.
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
    // MATTRESS / ACCESSORY / SERVICE — single base price.
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

// ----------------------------------------------------------------------------
// PO line cost from a SUPPLIER binding (Phase 3, Commander 2026-05-29).
//
// When creating a Purchase Order, each line's unit COST auto-fills from the
// SUPPLIER'S OWN price table (`supplier_material_bindings.price_matrix`) plus
// that supplier's maintenance surcharges — instead of the old flat copy of
// `binding.unit_price_centi`. Rules (commander-confirmed):
//   - Base = the binding's price_matrix (per category shape below).
//   - Tier default = P2; use P1 only when the line's fabric resolves to
//     PRICE_1 AND a P1 cell exists (the tier rule already lives inside
//     `computeMfgLineCost`).
//   - + supplier maintenance surcharges (COST side — reads each option's
//     `priceSen` via `computeMfgLineCost`).
//   - A manual unit-price override on the line always wins (handled by the
//     caller, not here).
//
// COMBOS ARE OUT OF SCOPE this phase: PO lines are per-SKU, so there is no
// combo override here. Combo pricing is deferred to a later phase.
//
// This helper is the binding→`MfgPricingProduct` projection layer; it owns no
// new pricing math — it reuses `computeMfgLineCost` for tier + surcharge logic.
// ----------------------------------------------------------------------------

/** Raw price_matrix as it arrives off the binding row (JSONB). Bedframe =
 *  `{P1?,P2?}` (sen); sofa = `{ "<seatSize>": {P1?,P2?,P3?} }` (sen). Null on
 *  rows / categories that use the flat `unit_price_centi`
 *  (mattress / accessory / service). */
export type PoPriceMatrix = Record<string, unknown> | null;

/** Defensive: read a numeric sen value, else null. Matrix cells may already
 *  be numbers; guards against strings / null / non-objects. */
const asSen = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Project a supplier binding's `price_matrix` + flat fallback into the
 *  `MfgPricingProduct` shape that `computeMfgLineCost` understands, then
 *  delegate. Pure — no I/O, safe in Workers and React.
 *
 *  - BEDFRAME: basePriceSen = matrix.P2; price1Sen = matrix.P1. When BOTH are
 *    missing → basePriceSen = `unitPriceCenti` (flat fallback).
 *  - SOFA: build seatHeightPrices from each `[size, cell]` — one row per
 *    populated tier (P2→PRICE_2, P1→PRICE_1, P3→PRICE_3). basePriceSen =
 *    `unitPriceCenti` so `computeMfgLineCost` falls back to flat when the
 *    matrix is empty / the picked seat size isn't found.
 *  - MATTRESS / ACCESSORY / SERVICE: basePriceSen = `unitPriceCenti`.
 *
 *  Tier handling (P2 default, P1 only on PRICE_1 + P1 present) lives inside
 *  `computeMfgLineCost`; we just pass `fabricTier` through. */
export function computeMfgPoUnitCost(
  input: {
    category: 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE';
    priceMatrix: PoPriceMatrix;
    /** Flat fallback (accessory / mattress / service + empty matrix). */
    unitPriceCenti: number;
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
      // Both missing → fall back to the flat binding price.
      basePriceSen: p2 ?? (p1 == null ? input.unitPriceCenti : null),
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
        if (p2 != null) seatHeightPrices.push({ height: size, tier: 'PRICE_2', priceSen: p2 });
        if (p1 != null) seatHeightPrices.push({ height: size, tier: 'PRICE_1', priceSen: p1 });
        if (p3 != null) seatHeightPrices.push({ height: size, tier: 'PRICE_3', priceSen: p3 });
      }
    }
    product = {
      category:     'SOFA',
      // Flat fallback when the matrix is empty or the picked seat size has no
      // row — computeMfgLineCost falls back to basePriceSen in that case.
      basePriceSen: input.unitPriceCenti,
      seatHeightPrices: seatHeightPrices.length > 0 ? seatHeightPrices : null,
    };
  } else {
    // MATTRESS / ACCESSORY / SERVICE — single flat price per SKU.
    product = { category: input.category, basePriceSen: input.unitPriceCenti };
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
