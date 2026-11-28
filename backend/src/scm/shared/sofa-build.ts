
import { pickComboMatch, type SofaComboRow, type SofaPriceTier } from './sofa-combo-pricing';
export type { SofaComboRow } from './sofa-combo-pricing';
export { comboChargedPrices } from './sofa-combo-pricing';
import { resolveSeatHeightSelling, resolveSeatHeightSen, type MfgSeatHeightPrice, type MfgFabricTier } from './mfg-pricing';


export type Rot = 0 | 90 | 180 | 270;
export type Depth = string;

export interface Cell {
  id?: string;
  moduleId: string;
  x: number;
  y: number;
  rot: Rot;
  recliners?: { seatIdx: number; open: boolean }[];
}

export interface SofaModuleSpec {
  id: string;
  group: '1-seater' | '2-seater' | '3-seater' | 'Corner' | 'L-Shape' | 'Accessory';
  label: string;
  w: number;
  d: number;
  cushions: number;
  accessory?: boolean;
}

export interface SofaProductPricingRow {
  compartmentId: string;
  active: boolean;
  priceSen: number;
}
export interface SofaProductPricingBundle {
  bundleId: string;
  active: boolean;
  priceSen: number;
}
export interface SofaProductPricing {
  compartments: SofaProductPricingRow[];
  bundles: SofaProductPricingBundle[];
  reclinerUpgradeSen: number;
  seatUpgradeLabel?: string | null;
  seatUpgradeFootrest?: boolean;
  fabrics?: SofaProductPricingFabric[];
  combos?: import('./sofa-combo-pricing').SofaComboRow[];
  accessories?: import('./sofa-combo-pricing').SofaPricedAccessory[];
  fabricTier?: import('./sofa-combo-pricing').SofaPriceTier | null;
  comboHeight?: string;
  baseModel?: string;
}

export interface SofaProductPricingFabric {
  fabricId: string;
  active: boolean;
  surcharge: number;
  colourIds: string[];
}

export interface BundleDef {
  id: string;
  label: string;
  signature: string;
  canonicalModules: readonly string[];
}

export interface SofaGroupPrice {
  cellIds: string[];
  signature: string;
  bundle: BundleDef | null;
  bundlePrice: number | null;
  aLaCarteTotal: number;
  reclinerCount: number;
  reclinerExtra: number;
  finalPrice: number;
  basis: 'combo' | 'bundle' | 'a_la_carte';
  comboPrice?: number | null;
  comboSubsetALaCarte?: number | null;
  comboExtrasALaCarte?: number | null;
  comboMatchedCellIds?: string[] | null;
  comboMatchedAccessoryIds?: string[];
  comboId?: string | null;
}

export interface SofaPriceResult {
  groups: SofaGroupPrice[];
  total: number;
}


export const SOFA_MODULES: readonly SofaModuleSpec[] = [
  { id: '1A(LHF)', group: '1-seater',  label: '1A · Left hand facing',  w: 95,  d: 95,  cushions: 1 },
  { id: '1A(RHF)', group: '1-seater',  label: '1A · Right hand facing', w: 95,  d: 95,  cushions: 1 },
  { id: '1B(LHF)', group: '1-seater',  label: '1B · Left hand facing (wide arm)',  w: 105, d: 95, cushions: 1 },
  { id: '1B(RHF)', group: '1-seater',  label: '1B · Right hand facing (wide arm)', w: 105, d: 95, cushions: 1 },
  { id: '1NA',    group: '1-seater',  label: '1NA · No arms',          w: 75,  d: 95,  cushions: 1 },
  { id: '2A(LHF)', group: '2-seater',  label: '2A · Left hand facing',  w: 158, d: 95,  cushions: 2 },
  { id: '2A(RHF)', group: '2-seater',  label: '2A · Right hand facing', w: 158, d: 95,  cushions: 2 },
  { id: '2B(LHF)', group: '2-seater',  label: '2B · Left hand facing (wide arm)',  w: 170, d: 95, cushions: 2 },
  { id: '2B(RHF)', group: '2-seater',  label: '2B · Right hand facing (wide arm)', w: 170, d: 95, cushions: 2 },
  { id: '2NA',    group: '2-seater',  label: '2NA · No arms',          w: 142, d: 95,  cushions: 2 },
  { id: 'CNR',    group: 'Corner',    label: 'Corner piece',           w: 95,  d: 95,  cushions: 1 },
  { id: 'L(LHF)',  group: 'L-Shape',   label: 'L · Left hand facing chaise',  w: 95, d: 165, cushions: 1 },
  { id: 'L(RHF)',  group: 'L-Shape',   label: 'L · Right hand facing chaise', w: 95, d: 165, cushions: 1 },
  { id: 'Console', group: 'Accessory', label: 'Wood console · 45cm',    w: 45,  d: 95,  cushions: 0, accessory: true },
  { id: 'STOOL',  group: 'Accessory', label: 'Ottoman / stool',        w: 75,  d: 75,  cushions: 0, accessory: true },
  { id: '1S', group: '1-seater', label: '1-Seater (both arms)', w: 115, d: 95, cushions: 1 },
  { id: '2S', group: '2-seater', label: '2-Seater (both arms)', w: 174, d: 95, cushions: 2 },
  { id: '3S', group: '3-seater', label: '3-Seater (both arms)', w: 220, d: 95, cushions: 3 },
  { id: '1A(P)(LHF)', group: '1-seater', label: '1A · Power · Left hand facing',      w: 95, d: 95, cushions: 1 },
  { id: '1A(P)(RHF)', group: '1-seater', label: '1A · Power · Right hand facing',     w: 95, d: 95, cushions: 1 },
  { id: '1A(R)(LHF)', group: '1-seater', label: '1A · Recliner · Left hand facing',   w: 95, d: 95, cushions: 1 },
  { id: '1A(R)(RHF)', group: '1-seater', label: '1A · Recliner · Right hand facing',  w: 95, d: 95, cushions: 1 },
  { id: '1A(L)(LHF)', group: '1-seater', label: '1A · Power leg · Left hand facing',  w: 95, d: 95, cushions: 1 },
  { id: '1A(L)(RHF)', group: '1-seater', label: '1A · Power leg · Right hand facing', w: 95, d: 95, cushions: 1 },
  { id: '1NA(P)', group: '1-seater', label: '1NA · Power · No arms',    w: 75, d: 95, cushions: 1 },
  { id: '1NA(R)', group: '1-seater', label: '1NA · Recliner · No arms', w: 75, d: 95, cushions: 1 },
  { id: '1NA(L)', group: '1-seater', label: '1NA · Power leg · No arms', w: 75, d: 95, cushions: 1 },
  { id: '1S(P)', group: '1-seater', label: '1S · Power · Both arms',     w: 115, d: 95, cushions: 1 },
  { id: '1S(R)', group: '1-seater', label: '1S · Recliner · Both arms',  w: 115, d: 95, cushions: 1 },
  { id: '1S(L)', group: '1-seater', label: '1S · Power leg · Both arms', w: 115, d: 95, cushions: 1 },
];

const MODULE_BY_ID = new Map<string, SofaModuleSpec>(SOFA_MODULES.map((m) => [m.id, m]));


export interface CompartmentStructure {
  base: string;
  orientation: 'LHF' | 'RHF' | null;
  mechanism: 'P' | 'R' | 'L' | null;
}

export const parseCompartmentStructure = (raw: string): CompartmentStructure | null => {
  const code = raw.trim();
  const m = code.match(/^([^()\s]+)\s*((?:\([^)]*\))*)$/);
  if (!m) return null;
  const base = (m[1] ?? '').toUpperCase();
  if (!base) return null;
  const tokens = Array.from((m[2] ?? '').matchAll(/\(([^)]*)\)/g)).map((t) => (t[1] ?? '').toUpperCase());
  const orientation = tokens.find((t): t is 'LHF' | 'RHF' => t === 'LHF' || t === 'RHF') ?? null;
  const mechanism = tokens.find((t): t is 'P' | 'R' | 'L' => t === 'P' || t === 'R' || t === 'L') ?? null;
  return { base, orientation, mechanism };
};

const familyRepresentative = (s: CompartmentStructure): string | undefined => {
  const o = s.orientation ?? 'LHF';
  switch (s.base) {
    case '1A': return `1A(${o})`;
    case '1B': return `1B(${o})`;
    case '2A': return `2A(${o})`;
    case '2B': return `2B(${o})`;
    case 'L':  return `L(${o})`;
    case '1NA': return '1NA';
    case '2NA': return '2NA';
    case '1S': return '1S';
    case '2S': return '2S';
    case '3S': return '3S';
    case 'CNR': return 'CNR';
    case 'CONSOLE': return 'Console';
    case 'STOOL': return 'STOOL';
    default: return undefined;
  }
};

const SYNTH_CACHE = new Map<string, SofaModuleSpec | undefined>();

const synthesizeModule = (id: string): SofaModuleSpec | undefined => {
  if (SYNTH_CACHE.has(id)) return SYNTH_CACHE.get(id);
  let spec: SofaModuleSpec | undefined;
  const s = parseCompartmentStructure(id);
  const rep = s ? familyRepresentative(s) : undefined;
  const repSpec = rep ? MODULE_BY_ID.get(rep) : undefined;
  if (repSpec && rep !== id) {
    spec = { ...repSpec, id, label: id };
  }
  SYNTH_CACHE.set(id, spec);
  return spec;
};

export const findModule = (id: string): SofaModuleSpec | undefined =>
  MODULE_BY_ID.get(id) ?? synthesizeModule(id);

/**
 * The asset key whose PNG/SVG a (possibly custom/one-shot) compartment code
 * should draw. Standard codes return themselves; synthesized codes like
 * '1A(LHF)(SEAT)(EXTEND)(40CM)' fall back to their base family representative
 * ('1A(LHF)') so a one-shot variant reuses the base compartment art with no
 * new asset + no maintenance-config write. Unknown families pass through.
 */
export const representativeArtCode = (code: string): string => {
  const norm = normalizeCompartmentCode(code);
  if (MODULE_BY_ID.has(norm)) return norm;
  const s = parseCompartmentStructure(norm);
  const rep = s ? familyRepresentative(s) : undefined;
  return rep ?? norm;
};

export const isAccessoryModule = (id: string): boolean => findModule(id)?.accessory === true;


export const normalizeCompartmentCode = (raw: string): string => {
  const dash = raw.trim().replace(/\(([^)]*)\)/g, '-$1').replace(/-+$/, '');
  const parts = dash.split('-').filter(Boolean);
  if (parts.length <= 1) return dash;
  return (parts[0] ?? '') + parts.slice(1).map((p) => `(${p})`).join('');
};

export type SofaCompartmentGroup =
  | '1-seater'
  | '2-seater'
  | '3-seater'
  | 'Corner'
  | 'L-Shape'
  | 'Accessory'
  | 'Other';

/** Best-effort classifier for a compartment code → POS palette group.
 *  Tries SOFA_MODULES first (canonical), falls back to a prefix heuristic
 *  so any recliner / console variant still lands in a sensible group. */
export const classifySofaCompartment = (rawCode: string): SofaCompartmentGroup => {
  const norm = normalizeCompartmentCode(rawCode);
  const known = MODULE_BY_ID.get(norm);
  if (known) return known.group;
  if (/^L[-(]/i.test(norm) || /^L$/i.test(norm)) return 'L-Shape';
  if (/^CNR$/i.test(norm) || /^CORNER/i.test(norm)) return 'Corner';
  if (/^STOOL|^Console|^WC-/i.test(norm)) return 'Accessory';
  if (/^2/.test(norm)) return '2-seater';
  if (/^1/.test(norm)) return '1-seater';
  return 'Other';
};

export const mirrorCode = (code: string): string => {
  if (code.includes('LHF')) return code.replace('LHF', 'RHF');
  if (code.includes('RHF')) return code.replace('RHF', 'LHF');
  return code;
};

/** Mirror a Quick Pick's OR-set slot layout left↔right. Pure; identical result
 *  on POS + server. */
export const mirrorModules = (modules: string[][]): string[][] =>
  modules.slice().reverse().map((slot) => slot.map(mirrorCode));

/** True when mirroring actually changes the layout. Symmetric palindromes
 *  (1-seater, 2-seater) mirror to themselves → false, so the POS hides the flip
 *  control for them. Compares the representative-code sequence (first code per
 *  slot) — that's what the preview + cart build consume. */
export const canMirror = (modules: string[][]): boolean => {
  const rep = (m: string[][]): string => m.map((s) => s[0] ?? '').join('+');
  return rep(modules) !== rep(mirrorModules(modules));
};


/** Per-Model module SELLING price map: normalized module code (dash form,
 *  matches a laid-out `cell.moduleId`) → price in sen. Built from the Model's
 *  sofa module-SKU `sell_price_sen`. */
export type SofaModulePriceSen = Record<string, number>;

/** Strip the `<BASE_MODEL>-` prefix off a sofa SKU code → the raw module code
 *  (parens form, e.g. `BOOQIT-2A(LHF)` → `2A(LHF)`). The SKU prefix is UPPER
 *  while `base_model` is Title-case, so the match is case-insensitive. Falls
 *  back to the substring after the first `-` when base_model is absent /
 *  mismatched (base models are single tokens with no internal dash). */
export const moduleCodeFromSku = (skuCode: string, baseModel: string | null | undefined): string => {
  const code = (skuCode ?? '').trim();
  const prefix = (baseModel ?? '').trim();
  if (prefix && code.toUpperCase().startsWith(`${prefix.toUpperCase()}-`)) {
    return code.slice(prefix.length + 1);
  }
  const dash = code.indexOf('-');
  return dash >= 0 ? code.slice(dash + 1) : code;
};

/** Build the per-Model module→price map (sen) from the Model's sofa SKU rows.
 *  Keyed by normalized module code. SKUs with a null `sell_price` are skipped
 *  (unpriced → no entry → priced 0 at lookup, never a phantom price). Whole-unit
 *  preset codes (1S / 2S / 3S) ARE first-class placeable modules (2026-06-01), so
 *  a laid-out cell can carry them and price directly from this map. */
export const sofaModulePricesFromSkus = (
  rows: Array<{ code: string; sellPriceSen: number | null }>,
  baseModel: string | null | undefined,
): SofaModulePriceSen => {
  const map: SofaModulePriceSen = {};
  for (const r of rows) {
    if (r.sellPriceSen == null) continue;
    map[normalizeCompartmentCode(moduleCodeFromSku(r.code, baseModel))] = r.sellPriceSen;
  }
  return map;
};

/** Build the per-Model module→SELLING-price map (sen) for the chosen depth+tier.
 *  For each SKU: prefer the per-(depth,tier) seatHeightPrices[].sellingPriceSen,
 *  else the flat module sell_price_sen, else drop (0/null → no entry → priced 0
 *  at lookup). Same normalized-code keying as sofaModulePricesFromSkus so POS and
 *  the server drift gate produce an identical map by construction — provided both
 *  call it with the SAME depth+tier (the "POS == server" invariant). Never reads
 *  `priceSen` (cost), so the buyer price can never leak the cost. */
export const sofaModuleSellingPricesFromSkus = (
  rows: Array<{
    code: string;
    sellPriceSen: number | null;
    seatHeightPrices?: MfgSeatHeightPrice[] | null;
  }>,
  baseModel: string | null | undefined,
  depth: string | null | undefined,
  tier: SofaPriceTier | null | undefined,
): SofaModulePriceSen => {
  const map: SofaModulePriceSen = {};
  for (const r of rows) {
    const seat = resolveSeatHeightSelling(r.seatHeightPrices, depth, tier ?? 'PRICE_2');
    const sen = seat?.sellingPriceSen ?? r.sellPriceSen ?? 0;
    if (sen <= 0) continue;
    map[normalizeCompartmentCode(moduleCodeFromSku(r.code, baseModel))] = sen;
  }
  return map;
};

/** Build the per-Model module→COST map (sen) for the chosen seat size + fabric
 *  tier. COST sibling of {@link sofaModuleSellingPricesFromSkus} (audit
 *  2026-06-11 C2 — a multi-module build's cost must be Σ module costs, not the
 *  first module SKU's flat cost). For each module SKU, the cost resolves the
 *  way `computeMfgLineCost`'s SOFA branch does:
 *    1. seat_height_prices[].priceSen at (seatSize, tier) — with the cost-side
 *       exact → PRICE_2 → any-tier fallback (resolveSeatHeightSen);
 *    2. else price1_sen when the fabric tier is PRICE_1;
 *    3. else flat base_price_sen, else cost_price_sen;
 *    4. nothing priced → no entry (priced 0 at lookup, never a phantom cost).
 *  Same normalized-code keying as the selling builder so a laid-out
 *  `cell.moduleId` looks up directly. Never reads `sellingPriceSen`. */
export const sofaModuleCostPricesFromSkus = (
  rows: Array<{
    code: string;
    basePriceSen: number | null;
    price1Sen?: number | null;
    costPriceSen?: number | null;
    seatHeightPrices?: MfgSeatHeightPrice[] | null;
  }>,
  baseModel: string | null | undefined,
  seatSize: string | null | undefined,
  tier: MfgFabricTier | null | undefined,
): SofaModulePriceSen => {
  const map: SofaModulePriceSen = {};
  for (const r of rows) {
    const seat = resolveSeatHeightSen(r.seatHeightPrices, seatSize, tier);
    const sen = seat != null
      ? seat.priceSen
      : (tier === 'PRICE_1' && r.price1Sen != null && r.price1Sen > 0)
        ? r.price1Sen
        : (r.basePriceSen ?? r.costPriceSen ?? null);
    if (sen == null || sen <= 0) continue;
    map[normalizeCompartmentCode(moduleCodeFromSku(r.code, baseModel))] = sen;
  }
  return map;
};

/** Build `SofaProductPricing.compartments` from a per-Model module→price map.
 *  `compartmentId` is normalised (matches a laid-out `cell.moduleId`); the price
 *  is carried through in SEN, unchanged. It used to be divided by 100 and
 *  ROUNDED here, which is where a part-ringgit module price was lost. */
export const sofaCompartmentsFromModulePrices = (
  prices: SofaModulePriceSen | null | undefined,
): SofaProductPricingRow[] => {
  if (!prices) return [];
  return Object.entries(prices).map(([code, sen]) => ({
    compartmentId: normalizeCompartmentCode(code),
    active: true,
    priceSen: sen,
  }));
};

/** Authoritative SELLING total (in sen) for a configured sofa. Reuses the same
 *  `computeSofaPrice` the POS uses, fed compartments from the Model's module→
 *  price map + combos (sofa_combo_pricing). mfg sofas carry no bundles and
 *  `reclinerUpgradeSen` 0 at pilot, so those are fixed here. Returns whole-
 *  build SEN — the engine carries sen throughout now, so there is no ×100. */
export const computeSofaSellingResult = (
  cells: Cell[],
  depth: Depth,
  modulePrices: SofaModulePriceSen | null | undefined,
  combos: SofaComboRow[],
  accessories: import('./sofa-combo-pricing').SofaPricedAccessory[] = [],
): SofaPriceResult => {
  const pricing: SofaProductPricing = {
    compartments: sofaCompartmentsFromModulePrices(modulePrices),
    bundles: [],
    reclinerUpgradeSen: 0,
    combos,
    accessories,
    fabricTier: 'PRICE_1',
    comboHeight: String(depth),
    baseModel: '',
  };
  return computeSofaPrice(cells, depth, pricing);
};

/** Total-only compatibility wrapper; use the result when consuming included pieces. */
export const computeSofaSellingSen = (
  cells: Cell[],
  depth: Depth,
  modulePrices: SofaModulePriceSen | null | undefined,
  combos: SofaComboRow[],
  accessories: import('./sofa-combo-pricing').SofaPricedAccessory[] = [],
): number => computeSofaSellingResult(cells, depth, modulePrices, combos, accessories).total;

/** Auto-detect a Combo's COST (sen) = Σ COST of each slot's representative
 *  (first) module code. A Combo is just existing module SKUs assembled, so its
 *  cost is the sum of those SKUs' COST (`base_price_sen`). Used to auto-key the
 *  Backend/PO cost when a Master Admin creates a Combo on POS with only the
 *  SELLING price (Chairman 2026-05-31; Backend-overridable). Unpriced modules
 *  contribute 0. Returns sen — the same ×100 scale as combo `pricesByHeight`. */
export const sofaComboCostSen = (
  modules: readonly string[][],
  moduleCosts: SofaModulePriceSen | null | undefined,
): number => {
  if (!moduleCosts) return 0;
  let sum = 0;
  for (const slot of modules) {
    const code = slot[0];
    if (!code) continue;
    sum += moduleCosts[normalizeCompartmentCode(code)] ?? 0;
  }
  return sum;
};


const RECLINER_FAMILIES = new Set(['1A', '1B', '2A', '2B', '1NA', '2NA']);
export const reclinerEligible = (modId: string): boolean => {
  const s = parseCompartmentStructure(modId);
  if (!s || s.mechanism) return false;
  return RECLINER_FAMILIES.has(s.base);
};
export const seatCount = (modId: string): number => {
  if (!reclinerEligible(modId)) return 0;
  const s = parseCompartmentStructure(modId);
  return s?.base.startsWith('2') ? 2 : 1;
};


export const moduleFamily = (id: string): string => {
  const paren = id.indexOf('(');
  return paren > 0 ? id.slice(0, paren) : id;
};

export const familySignature = (modIds: string[]): string =>
  modIds
    .filter((id) => !isAccessoryModule(id))
    .map(moduleFamily)
    .sort()
    .join('+');

const BUNDLE_FAMILY_COLLAPSE: Record<string, string> = {
  '1B': '1A',
  '2B': '2A',
};
const bundleFamily = (id: string): string => {
  const fam = moduleFamily(id);
  return BUNDLE_FAMILY_COLLAPSE[fam] ?? fam;
};
const bundleSignature = (modIds: string[]): string =>
  modIds
    .filter((id) => !isAccessoryModule(id))
    .map(bundleFamily)
    .sort()
    .join('+');

/** A "wide-arm" B-variant seat (1B / 2B) — i.e. a family that BUNDLE_FAMILY_COLLAPSE
 *  folds into an A family for DETECTION. detectBundle deliberately collapses these
 *  so a build containing them still MATCHES a bundle (and so prices/combos work),
 *  but the canonical SKU breakdown (resolveSku in the configurator's auto-convert)
 *  only emits A/NA/L families and cannot express a B variant. The auto-convert must
 *  therefore SKIP any group containing one, exactly like it skips accessories and
 *  functional seats — otherwise it silently rewrites the customer's deliberate
 *  1B/2B into a 1A/2A, showing a different compartment than they picked
 *  (Loo 2026-06-03 bug). Single source of truth = BUNDLE_FAMILY_COLLAPSE. */
export const isWideArmSeat = (id: string): boolean =>
  Object.prototype.hasOwnProperty.call(BUNDLE_FAMILY_COLLAPSE, moduleFamily(id));

export const BUNDLES: readonly BundleDef[] = [
  { id: '1S',  label: '1-Seater', signature: '1A',       canonicalModules: ['1A'] },
  { id: '2S',  label: '2-Seater', signature: '2A',       canonicalModules: ['2A'] },
  { id: '2.5S',label: '2.5-Seater',signature: '2.5A',    canonicalModules: ['2A'] },
  { id: '3S',  label: '3-Seater', signature: '1A+2A',    canonicalModules: ['1A', '2A'] },
  { id: '2+L', label: '2 + L',    signature: '2A+L',     canonicalModules: ['2A', 'L'] },
  { id: '3+L', label: '3 + L',    signature: '1NA+2A+L', canonicalModules: ['2A', '1NA', 'L'] },
  { id: '2WC', label: '2-Seater + Console', signature: '2WC-PRESET', canonicalModules: ['1A', 'Console', '1A'] },
  { id: '2PS', label: '2-Seater + 2 Power slide', signature: '2PS-PRESET', canonicalModules: ['2A'] },
  { id: 'CORNER', label: 'Corner', signature: 'CORNER-PRESET', canonicalModules: ['1A', 'CNR', '2A'] },
];

const BY_2S = '2S' as const;
const BY_3S = '3S' as const;
const BY_2L = '2+L' as const;
const BY_3L = '3+L' as const;
const BUNDLE_BY_SIG = new Map<string, BundleDef>([
  ...BUNDLES.map((b) => [b.signature, b] as const),
  ['1A+1A',         BUNDLES.find((b) => b.id === BY_2S)!],
  ['1A+1A+1NA',     BUNDLES.find((b) => b.id === BY_3S)!],
  ['1A+1A+L',       BUNDLES.find((b) => b.id === BY_2L)!],
  ['1A+2NA+L',      BUNDLES.find((b) => b.id === BY_3L)!],
  ['1A+1A+1NA+L',   BUNDLES.find((b) => b.id === BY_3L)!],
]);

export const detectBundle = (modIds: string[]): BundleDef | null =>
  BUNDLE_BY_SIG.get(bundleSignature(modIds)) ?? null;

/**
 * Human-readable cart/quote label for a sofa group. Mirrors the bundle-vs-
 * à-la-carte decision in `groupPrice` (single-module short-circuit included),
 * but skipped the pricing-row.active check because callers may not have
 * pricing in hand (e.g., re-rendering a stored cart line).
 *
 * Bundle-matched closed group → commercial bundle label, with the compartment
 * make-up appended for multi-module groups ("2 + L (2A+L)") so the cart line
 * shows WHAT the sofa is built from (Loo 2026-06-04 — same parenthesised
 * format as the Custom fallback; single-module bundles like a whole-piece
 * 2-Seater stay bare).
 * Anything else → `Custom (<family-signature>)` so distinct custom builds in
 * the same cart stay distinguishable.
 */
export const summarizeSofaCells = (
  cells: Cell[],
  depth: Depth,
  seatUpgradeLabel?: string | null,
): string => {
  if (cells.length === 0) return 'Custom (empty)';
  const modIds = cells.map((c) => c.moduleId);
  const candidate = detectBundle(modIds);
  let base: string;
  if (candidate && cells.length === 1) {
    base = candidate.label;
  } else if (candidate && analyzeSofa(cells, depth).closed) {
    base = `${candidate.label} (${familySignature(modIds)})`;
  } else {
    base = `Custom (${familySignature(modIds)})`;
  }
  const upgradeCount = cells.reduce((n, c) => n + (c.recliners?.length ?? 0), 0);
  if (seatUpgradeLabel && upgradeCount > 0) {
    base += ` + ${upgradeCount} ${seatUpgradeLabel}`;
  }
  return base;
};


const SINGLE_PIECE_BUNDLES = new Set(['1S', '2S', '2.5S']);

const BUNDLE_INVOICE_DECOMP: Record<string, string> = {
  '3S':  '1A(LHF) + 2A(RHF)',
  '2+L': '2A(LHF) + L(RHF)',
  '3+L': '2A(LHF) + 1NA + L(RHF)',
  '2WC': '1A(LHF) + Console + 1A(RHF)',
  'CORNER': '1A(LHF) + CNR + 2A(RHF)',
};

const bundleLabelById = (bundleId: string): string =>
  BUNDLES.find((b) => b.id === bundleId)?.label ?? bundleId;

const bundleSeatCount = (bundleId: string): number => {
  const b = BUNDLES.find((x) => x.id === bundleId);
  if (!b) return 0;
  return b.canonicalModules.reduce(
    (n, fam) => n + (fam.startsWith('2') ? 2 : fam.startsWith('1') ? 1 : 0),
    0,
  );
};

export interface SofaLineDescriptor {
  bundleId?: string;
  cells?: Cell[];
  depth?: Depth;
  seatUpgradeLabel?: string | null;
  seatUpgradeFootrest?: boolean;
}

/**
 * Human-readable description for a sofa order/invoice line (Track 2 §8.1):
 *   - single-piece bundle (1S/2S/2.5S) → bundle name ("2-Seater")
 *   - multi-piece bundle (3S/2+L/…)    → decomposed module ids ("1A(LHF) + 2A(RHF)")
 *   - Custom Build cells               → the cells' own oriented ids, left-to-right
 *     (a console / any accessory in the cells forces decomposition so it stays visible)
 *   - any seat upgrades                → "+ N <seatUpgradeLabel>" appended
 */
export const describeSofaLine = (cfg: SofaLineDescriptor): string => {
  const depth: Depth = cfg.depth ?? '24';

  if (cfg.cells && cfg.cells.length > 0) {
    const cells = cfg.cells;
    const modIds = cells.map((c) => c.moduleId);
    const hasAccessory = modIds.some(isAccessoryModule);
    const candidate = detectBundle(modIds);
    const closed = cells.length === 1 || analyzeSofa(cells, depth).closed;

    let base: string;
    if (candidate && closed && !hasAccessory && SINGLE_PIECE_BUNDLES.has(candidate.id)) {
      base = candidate.label;
    } else {
      base = orderSofaCellsLeftToRight(cells, depth)
        .map((c) => c.moduleId)
        .join(' + ');
    }

    const upgradeCount = cells.reduce((n, c) => n + (c.recliners?.length ?? 0), 0);
    if (cfg.seatUpgradeLabel && upgradeCount > 0) {
      base += ` + ${upgradeCount} ${cfg.seatUpgradeLabel}`;
    }
    return base;
  }

  if (cfg.bundleId) {
    const base = SINGLE_PIECE_BUNDLES.has(cfg.bundleId)
      ? bundleLabelById(cfg.bundleId)
      : (BUNDLE_INVOICE_DECOMP[cfg.bundleId] ?? bundleLabelById(cfg.bundleId));
    if (cfg.seatUpgradeLabel && cfg.seatUpgradeFootrest === false) {
      const n = bundleSeatCount(cfg.bundleId);
      if (n > 0) return `${base} + ${n} ${cfg.seatUpgradeLabel}`;
    }
    return base;
  }

  return 'Sofa';
};


export type EdgeType = 'arm' | 'open' | 'back' | 'front';
export type EdgeIdx = 0 | 1 | 2 | 3;
export const EDGE_W: EdgeIdx = 0;
export const EDGE_N: EdgeIdx = 1;
export const EDGE_E: EdgeIdx = 2;
export const EDGE_S: EdgeIdx = 3;

const MODULE_EDGES_BASE: Record<string, [EdgeType, EdgeType, EdgeType, EdgeType]> = {
  '1A(LHF)': ['arm',  'back', 'open', 'front'],
  '1A(RHF)': ['open', 'back', 'arm',  'front'],
  '1B(LHF)': ['arm',  'back', 'open', 'front'],
  '1B(RHF)': ['open', 'back', 'arm',  'front'],
  '1NA':    ['open', 'back', 'open', 'front'],
  '2A(LHF)': ['arm',  'back', 'open', 'front'],
  '2A(RHF)': ['open', 'back', 'arm',  'front'],
  '2B(LHF)': ['arm',  'back', 'open', 'front'],
  '2B(RHF)': ['open', 'back', 'arm',  'front'],
  '2NA':    ['open', 'back', 'open', 'front'],
  'CNR':    ['arm',  'arm',  'open', 'open'],
  'L(LHF)':  ['open', 'back', 'open', 'front'],
  'L(RHF)':  ['open', 'back', 'open', 'front'],
  'Console':['open', 'open', 'open', 'open'],
  'STOOL':  ['open', 'open', 'open', 'open'],
  '1S': ['arm', 'back', 'arm', 'front'],
  '2S': ['arm', 'back', 'arm', 'front'],
  '3S': ['arm', 'back', 'arm', 'front'],
  '1A(P)(LHF)': ['arm',  'back', 'open', 'front'],
  '1A(P)(RHF)': ['open', 'back', 'arm',  'front'],
  '1A(R)(LHF)': ['arm',  'back', 'open', 'front'],
  '1A(R)(RHF)': ['open', 'back', 'arm',  'front'],
  '1A(L)(LHF)': ['arm',  'back', 'open', 'front'],
  '1A(L)(RHF)': ['open', 'back', 'arm',  'front'],
  '1NA(P)': ['open', 'back', 'open', 'front'],
  '1NA(R)': ['open', 'back', 'open', 'front'],
  '1NA(L)': ['open', 'back', 'open', 'front'],
  '1S(P)': ['arm', 'back', 'arm', 'front'],
  '1S(R)': ['arm', 'back', 'arm', 'front'],
  '1S(L)': ['arm', 'back', 'arm', 'front'],
};

const rotateEdges = (edges: EdgeType[], rot: Rot): EdgeType[] => {
  const r = ((rot % 360) + 360) % 360;
  const turns = r / 90;
  const out = edges.slice();
  for (let i = 0; i < turns; i++) out.unshift(out.pop()!);
  return out;
};

export const cellEdges = (cell: Cell): EdgeType[] => {
  let base: (typeof MODULE_EDGES_BASE)[string] | undefined = MODULE_EDGES_BASE[cell.moduleId];
  if (!base) {
    const s = parseCompartmentStructure(cell.moduleId);
    const rep = s ? familyRepresentative(s) : undefined;
    base = rep ? MODULE_EDGES_BASE[rep] : undefined;
  }
  if (!base) return ['open', 'open', 'open', 'open'];
  return rotateEdges(base, cell.rot);
};

/** The OUTER cap edge of an L-Shape chaise — the short end AWAY from the main
 *  sofa, where the standalone chaise art bakes in its arm. Returns -1 for any
 *  non-L module. The chaise carries NO 'arm'-typed edge (both short ends are
 *  'open'), so closure (analyzeSofa) and the seamless renderer derive the arm
 *  side from here instead: L(RHF) mates on W → cap on E; L(LHF) mates on E →
 *  cap on W; CW rotation shifts the edge index +1 per 90° (same convention as
 *  rotateEdges). Single source of truth so the two callers can't drift. */
export const lCapEdgeOf = (moduleId: string, rot: Rot): EdgeIdx | -1 => {
  if (!moduleId.startsWith('L(')) return -1;
  const baseCap: EdgeIdx = moduleId === 'L(RHF)' ? EDGE_E : EDGE_W;
  const steps = (((rot % 360) + 360) % 360) / 90;
  return ((baseCap + steps) % 4) as EdgeIdx;
};


const widthOffsetPerCushion = (depth: Depth): number => {
  const inch = parseInt(depth, 10);
  return Number.isFinite(inch) ? Math.max(0, (inch - 24) * 2.5) : 0;
};

export const moduleFootprint = (m: SofaModuleSpec, rot: Rot, depth: Depth): { w: number; h: number } => {
  const w = m.w + widthOffsetPerCushion(depth) * m.cushions;
  const h = m.d;
  return rot % 180 === 0 ? { w, h } : { w: h, h: w };
};

export interface Bbox { x: number; y: number; w: number; h: number }

export const cellBbox = (cell: Cell, depth: Depth): Bbox | null => {
  const m = findModule(cell.moduleId);
  if (!m) return null;
  const fp = moduleFootprint(m, cell.rot, depth);
  return { x: cell.x, y: cell.y, w: fp.w, h: fp.h };
};

const FOOTREST_CM = 35;
export const cellEffectiveBbox = (cell: Cell, depth: Depth): Bbox | null => {
  const b = cellBbox(cell, depth);
  if (!b) return null;
  const hasOpen = (cell.recliners ?? []).some((r) => r.open);
  if (!hasOpen) return b;
  const r = ((cell.rot % 360) + 360) % 360;
  switch (r) {
    case 0:   return { x: b.x,                y: b.y,                w: b.w,                  h: b.h + FOOTREST_CM };
    case 90:  return { x: b.x - FOOTREST_CM,  y: b.y,                w: b.w + FOOTREST_CM,    h: b.h };
    case 180: return { x: b.x,                y: b.y - FOOTREST_CM,  w: b.w,                  h: b.h + FOOTREST_CM };
    default:  return { x: b.x,                y: b.y,                w: b.w + FOOTREST_CM,    h: b.h };
  }
};

export const cellsBbox = (cells: Cell[], depth: Depth): Bbox | null => {
  if (cells.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cells) {
    const b = cellBbox(c, depth);
    if (!b) continue;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

export const centerCellsWithin = (cells: Cell[], depth: Depth, w: number, h: number): Cell[] => {
  const bb = cellsBbox(cells, depth);
  if (!bb) return cells;
  const dx = w / 2 - bb.w / 2 - bb.x;
  const dy = h / 2 - bb.h / 2 - bb.y;
  return cells.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
};


const CONTACT_TOL = 2;

interface EdgePair { edgeA: EdgeIdx; edgeB: EdgeIdx }

export const edgeContacts = (a: Cell, b: Cell, depth: Depth): EdgePair[] => {
  const ba = cellBbox(a, depth);
  const bb = cellBbox(b, depth);
  if (!ba || !bb) return [];
  const out: EdgePair[] = [];
  if (Math.abs(ba.x + ba.w - bb.x) <= CONTACT_TOL) {
    const yOv = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
    if (yOv > CONTACT_TOL) out.push({ edgeA: EDGE_E, edgeB: EDGE_W });
  }
  if (Math.abs(ba.x - (bb.x + bb.w)) <= CONTACT_TOL) {
    const yOv = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y);
    if (yOv > CONTACT_TOL) out.push({ edgeA: EDGE_W, edgeB: EDGE_E });
  }
  if (Math.abs(ba.y + ba.h - bb.y) <= CONTACT_TOL) {
    const xOv = Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x);
    if (xOv > CONTACT_TOL) out.push({ edgeA: EDGE_S, edgeB: EDGE_N });
  }
  if (Math.abs(ba.y - (bb.y + bb.h)) <= CONTACT_TOL) {
    const xOv = Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x);
    if (xOv > CONTACT_TOL) out.push({ edgeA: EDGE_N, edgeB: EDGE_S });
  }
  return out;
};

const hasConnectingContact = (a: Cell, b: Cell, depth: Depth): boolean => {
  const contacts = edgeContacts(a, b, depth);
  if (contacts.length === 0) return false;
  const ea = cellEdges(a);
  const eb = cellEdges(b);
  const connectable = (t: EdgeType | undefined): boolean => t === 'arm' || t === 'open';
  return contacts.some(({ edgeA, edgeB }) => connectable(ea[edgeA]) && connectable(eb[edgeB]));
};

/** Union-find by edge contact. Returns array of cell groups (each its own sofa). */
export const groupSofas = (cells: Cell[], depth: Depth): Cell[][] => {
  if (cells.length === 0) return [];
  const parent: number[] = cells.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      parent[i] = parent[parent[i]!]!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const ci = cells[i], cj = cells[j];
      if (!ci || !cj) continue;
      if (hasConnectingContact(ci, cj, depth)) union(i, j);
    }
  }
  const groups = new Map<number, Cell[]>();
  cells.forEach((c, idx) => {
    const root = find(idx);
    const arr = groups.get(root) ?? [];
    arr.push(c);
    groups.set(root, arr);
  });
  return Array.from(groups.values());
};


/**
 * Canonical LEFT-TO-RIGHT order of a build's cells: wherever compartment
 * codes appear as a sequence (configurator topbar, SO per-module lines, cart
 * titles, customer print, DO/SI), they read like the customer facing the
 * sofa — from the leftmost arm to the rightmost arm (1A(LHF) … 2A(RHF)).
 * An L/U build is WALKED along its connected chain, so the left chaise wing
 * comes first, then the corner, then across to the right arm. A naive (x, y)
 * sort puts a top-left corner BEFORE the chaise hanging below it
 * ("CNR + 1B(LHF) + 2A(RHF)") — the exact order Loo rejected; the walk yields
 * "1B(LHF) + CNR + 2A(RHF)".
 *
 * Walk start: the chain endpoint with the smaller bbox-centre x; same column
 * (vertical run) falls back to the LHF-coded end, then the higher end.
 * Degraded inputs never invent an order: a branch/cycle (not buildable
 * today) or a free-standing piece sorts stable-by-(x, y) within its group;
 * groups follow each other leftmost-first; missing geometry or an unknown
 * module keeps the stored order untouched.
 */
export const orderSofaCellsLeftToRight = (cells: Cell[], depth: Depth): Cell[] => {
  if (cells.length <= 1) return cells.slice();
  const boxes = new Map<Cell, Bbox>();
  for (const c of cells) {
    if (typeof c.moduleId !== 'string' || !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      return cells.slice();
    }
    const b = cellBbox(c, depth);
    if (!b) return cells.slice();
    boxes.set(c, b);
  }
  const inputIdx = new Map<Cell, number>(cells.map((c, i) => [c, i]));
  const centreX = (c: Cell): number => { const b = boxes.get(c)!; return b.x + b.w / 2; };
  const centreY = (c: Cell): number => { const b = boxes.get(c)!; return b.y + b.h / 2; };

  const readingSort = (group: Cell[]): Cell[] =>
    [...group].sort((a, b) =>
      (boxes.get(a)!.x - boxes.get(b)!.x) ||
      (boxes.get(a)!.y - boxes.get(b)!.y) ||
      (inputIdx.get(a)! - inputIdx.get(b)!));

  const orderGroup = (group: Cell[]): Cell[] => {
    if (group.length <= 1) return group;
    const adj: number[][] = group.map(() => []);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (hasConnectingContact(group[i]!, group[j]!, depth)) {
          adj[i]!.push(j);
          adj[j]!.push(i);
        }
      }
    }
    const ends = adj.flatMap((n, i) => (n.length <= 1 ? [i] : []));
    const isChain = adj.every((n) => n.length <= 2) && ends.length === 2;
    if (!isChain) return readingSort(group);
    const [a, b] = ends as [number, number];
    const handOf = (i: number): 'LHF' | 'RHF' | null =>
      parseCompartmentStructure(group[i]!.moduleId)?.orientation ?? null;
    const handA = handOf(a);
    const handB = handOf(b);
    const X_TIE = 1;
    const dx = centreX(group[a]!) - centreX(group[b]!);
    let start: number;
    if (handA === 'LHF' && handB === 'RHF') start = a;
    else if (handB === 'LHF' && handA === 'RHF') start = b;
    else if (Math.abs(dx) > X_TIE) start = dx < 0 ? a : b;
    else if (handA === 'LHF' && handB !== 'LHF') start = a;
    else if (handB === 'LHF' && handA !== 'LHF') start = b;
    else start = centreY(group[a]!) <= centreY(group[b]!) ? a : b;
    const out: Cell[] = [];
    const seen = new Set<number>();
    let cur: number | undefined = start;
    while (cur !== undefined) {
      seen.add(cur);
      out.push(group[cur]!);
      cur = adj[cur]!.find((n) => !seen.has(n));
    }
    return out.length === group.length ? out : readingSort(group);
  };

  return groupSofas(cells, depth)
    .map((g) => ({ g, b: cellsBbox(g, depth)! }))
    .sort((A, B) =>
      (A.b.x - B.b.x) || (A.b.y - B.b.y) ||
      (inputIdx.get(A.g[0]!)! - inputIdx.get(B.g[0]!)!))
    .flatMap(({ g }) => orderGroup(g));
};


const compRow = (pricing: SofaProductPricing, compartmentId: string): SofaProductPricingRow | undefined =>
  pricing.compartments.find((c) => c.compartmentId === compartmentId);

const bundleRow = (pricing: SofaProductPricing, bundleId: string): SofaProductPricingBundle | undefined =>
  pricing.bundles.find((b) => b.bundleId === bundleId);

/** Surcharge for an ACTIVE fabric on this Model, else 0. Pure; used by the POS
 *  LIVE TOTAL. The server (`computeOrderTotal`) does strict validation before
 *  adding the same value. */
export const fabricSurchargeFor = (
  pricing: SofaProductPricing,
  fabricId: string | undefined,
): number => {
  if (!fabricId) return 0;
  const f = pricing.fabrics?.find((x) => x.fabricId === fabricId && x.active);
  return f?.surcharge ?? 0;
};

/** Display-only " · <fabric> / <colour>" suffix for an invoice / cart sofa line.
 *  Empty string when either label is missing. */
export const fabricColourSuffix = (
  fabricLabel?: string | null,
  colourLabel?: string | null,
): string => (fabricLabel && colourLabel ? ` · ${fabricLabel} / ${colourLabel}` : '');

const groupPrice = (group: Cell[], depth: Depth, pricing: SofaProductPricing): SofaGroupPrice => {
  const cellIds = group.map((c, i) => c.id ?? `__cell_${i}`);
  const modIds = group.map((c) => c.moduleId);
  const signature = familySignature(modIds);

  let aLaCarteTotal = 0;
  for (const cell of group) {
    const row = compRow(pricing, cell.moduleId)
      ?? compRow(pricing, mirrorCode(cell.moduleId));
    aLaCarteTotal += row?.priceSen ?? 0;
  }

  const candidate = detectBundle(modIds);
  let bundle: BundleDef | null = null;
  let bundlePrice: number | null = null;
  let basis: 'combo' | 'bundle' | 'a_la_carte' = 'a_la_carte';

  if (candidate) {
    const row = bundleRow(pricing, candidate.id);
    const closed = group.length === 1 || analyzeSofa(group, depth).closed;
    if (row && row.active && closed) {
      bundle = candidate;
      bundlePrice = row.priceSen;
      basis = 'bundle';
    }
  }

  let comboPrice: number | null = null;
  let comboSubsetALaCarte: number | null = null;
  let comboExtrasALaCarte: number | null = null;
  let comboMatchedCellIds: string[] | null = null;
  let comboMatchedAccessoryIds: string[] = [];
  let comboId: string | null = null;
  if (pricing.combos && pricing.combos.length > 0) {
    const heightStr = pricing.comboHeight ?? String(depth);
    const match = pickComboMatch(
      {
        baseModel: pricing.baseModel ?? '',
        modules: modIds,
        cellIds,
        accessories: pricing.accessories,
        customerId: null,
        tier: pricing.fabricTier ?? 'PRICE_2',
        height: heightStr,
      },
      pricing.combos,
    );
    if (match) {
      const comboPriceSen = match.comboPriceSen;
      const matchedSet = new Set(match.matchedIndices);
      let subsetSum = 0;
      for (let i = 0; i < group.length; i++) {
        if (!matchedSet.has(i)) continue;
        const cell = group[i]!;
        const row = compRow(pricing, cell.moduleId)
          ?? compRow(pricing, mirrorCode(cell.moduleId));
        subsetSum += row?.priceSen ?? 0;
      }
      if (comboPriceSen > 0) {
        basis = 'combo';
        comboPrice = comboPriceSen;
        const includedIds = new Set(match.matchedAccessoryIds);
        const seenPieces = new Set<string>();
        const includedAccessoriesSen = (pricing.accessories ?? []).reduce((sum, p) => {
          if (!includedIds.has(p.id) || seenPieces.has(p.id)) return sum;
          seenPieces.add(p.id);
          return sum + (Number.isFinite(p.priceSen) && p.priceSen > 0 ? p.priceSen : 0);
        }, 0);
        comboSubsetALaCarte = subsetSum + includedAccessoriesSen;
        comboExtrasALaCarte = Math.max(0, aLaCarteTotal - subsetSum);
        comboMatchedCellIds = match.matchedIndices.map((i) => cellIds[i]!);
        comboMatchedAccessoryIds = match.matchedAccessoryIds;
        comboId = match.row.id;
        bundle = null;
        bundlePrice = null;
      }
    }
  }

  let reclinerCount = 0;
  for (const cell of group) {
    if (!reclinerEligible(cell.moduleId)) continue;
    reclinerCount += (cell.recliners ?? []).length;
  }
  const reclinerExtra = reclinerCount * pricing.reclinerUpgradeSen;

  let basePrice: number;
  if (basis === 'combo' && comboPrice != null) {
    basePrice = comboPrice + (comboExtrasALaCarte ?? 0);
  } else if (basis === 'bundle' && bundlePrice != null) {
    basePrice = bundlePrice;
  } else {
    basePrice = aLaCarteTotal;
  }

  const finalPrice = basePrice + reclinerExtra;

  return {
    cellIds,
    signature,
    bundle,
    bundlePrice,
    aLaCarteTotal,
    reclinerCount,
    reclinerExtra,
    finalPrice,
    basis,
    comboPrice,
    comboSubsetALaCarte,
    comboExtrasALaCarte,
    comboMatchedCellIds,
    comboMatchedAccessoryIds,
    comboId,
  };
};

/**
 * Compute the price of a sofa cart line.
 *
 * Splits cells into independent sofa groups via edge-contact union-find, then
 * prices each group: à la carte sum (sum of comp.priceSen per cell), bundle override
 * if the signature matches AND bundle.active AND bundle.priceSen < à la carte, plus
 * recliner upgrades counted globally and added to the chosen base.
 *
 * `pricing` is the per-Model SofaProductPricing — Backend SKU Master writes it
 * to `product_compartments` + `product_bundles` + `products.recliner_upgrade_price`.
 * Server-side recompute on POST /orders MUST call this with the same inputs.
 */
export const computeSofaPrice = (
  cells: Cell[],
  depth: Depth,
  pricing: SofaProductPricing,
): SofaPriceResult => {
  const groups = groupSofas(cells, depth);
  const groupPrices = groups.map((g) => groupPrice(g, depth, pricing));
  const total = groupPrices.reduce((sum, g) => sum + g.finalPrice, 0);
  return { groups: groupPrices, total };
};


/** Threshold in cm — drag releases snap to a neighbour edge if within this. */
export const SNAP_CM = 20;

export interface SnapDelta { dx: number; dy: number }

/**
 * Best-effort drag snap: given a candidate bbox (where the dragged cell would
 * land if released raw) and the rest of the cells, compute a (dx, dy) shift
 * that aligns the dragged cell's edges to the nearest neighbour within
 * `SNAP_CM`. Returns {0,0} if nothing is close enough.
 *
 * The X-axis snap only fires when the cells overlap on Y (so we're snapping a
 * horizontal seam, not snapping past a remote piece). Same logic mirrored on Y.
 */
export const findSnap = (
  draggedBbox: Bbox,
  otherCells: Cell[],
  ignoreId: string | undefined,
  depth: Depth,
): SnapDelta => {
  let bestDx = 0, bestDy = 0;
  let bestX = SNAP_CM, bestY = SNAP_CM;
  const ax1 = draggedBbox.x, ax2 = draggedBbox.x + draggedBbox.w;
  const ay1 = draggedBbox.y, ay2 = draggedBbox.y + draggedBbox.h;

  for (const c of otherCells) {
    if (ignoreId !== undefined && c.id === ignoreId) continue;
    const b = cellBbox(c, depth);
    if (!b) continue;
    const bx1 = b.x, bx2 = b.x + b.w;
    const by1 = b.y, by2 = b.y + b.h;

    const yOverlap = Math.min(ay2, by2) - Math.max(ay1, by1);
    if (yOverlap > -SNAP_CM) {
      let d = bx1 - ax2; if (Math.abs(d) < bestX) { bestX = Math.abs(d); bestDx = d; }
      d = bx2 - ax1;     if (Math.abs(d) < bestX) { bestX = Math.abs(d); bestDx = d; }
      d = bx1 - ax1;     if (Math.abs(d) < bestX) { bestX = Math.abs(d); bestDx = d; }
      d = bx2 - ax2;     if (Math.abs(d) < bestX) { bestX = Math.abs(d); bestDx = d; }
    }

    const xOverlap = Math.min(ax2, bx2) - Math.max(ax1, bx1);
    if (xOverlap > -SNAP_CM) {
      let d = by1 - ay2; if (Math.abs(d) < bestY) { bestY = Math.abs(d); bestDy = d; }
      d = by2 - ay1;     if (Math.abs(d) < bestY) { bestY = Math.abs(d); bestDy = d; }
      d = by1 - ay1;     if (Math.abs(d) < bestY) { bestY = Math.abs(d); bestDy = d; }
      d = by2 - ay2;     if (Math.abs(d) < bestY) { bestY = Math.abs(d); bestDy = d; }
    }
  }

  return {
    dx: bestX < SNAP_CM ? bestDx : 0,
    dy: bestY < SNAP_CM ? bestDy : 0,
  };
};


export type ViolationReason = 'Arm-to-arm' | 'Arm blocked by module';
export interface ArmViolation { aId: string; bId: string; reason: ViolationReason }

export type ClosureFailure =
  | 'Arms colliding'
  | 'No arms on either end'
  | 'Left end has no arm'
  | 'Right end has no arm'
  | 'Top end has no arm'
  | 'Bottom end has no arm'
  | 'Console needs a sofa next to it';

export interface SofaAnalysis {
  violations: ArmViolation[];
  closed: boolean;
  reason: ClosureFailure | null;
  leftArm: boolean;
  rightArm: boolean;
}

const cellKey = (c: Cell, idx: number): string => c.id ?? `__cell_${idx}`;

/**
 * Quick check used by the drop-to-mirror UI: would `cell` have any
 * arm-touching-anything contact with the rest of `allCells`? Cheaper than
 * the full analyzeSofa pass.
 */
export const hasArmConflict = (cell: Cell, allCells: Cell[], depth: Depth): boolean => {
  const myEdges = cellEdges(cell);
  for (const other of allCells) {
    if (other === cell) continue;
    if (cell.id !== undefined && other.id === cell.id) continue;
    const cs = edgeContacts(cell, other, depth);
    if (!cs.length) continue;
    const oEdges = cellEdges(other);
    for (const { edgeA, edgeB } of cs) {
      const tA = myEdges[edgeA];
      const tB = oEdges[edgeB];
      if (tA === 'arm' || tB === 'arm') return true;
    }
  }
  return false;
};

/**
 * Validate one sofa group: collect arm-arm / arm-blocked-by-module
 * violations, decide closure (must have an arm at each end of the dominant
 * axis, treating an L-module's outer edge as a self-closing cap).
 */
export const analyzeSofa = (group: Cell[], depth: Depth): SofaAnalysis => {
  const violations: ArmViolation[] = [];
  const ids = group.map(cellKey);
  const contactsByCell: Record<string, { otherId: string; myEdge: EdgeIdx; myType: EdgeType; otherType: EdgeType }[]> = {};
  ids.forEach((id) => { contactsByCell[id] = []; });

  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i]!;
      const b = group[j]!;
      const cs = edgeContacts(a, b, depth);
      if (!cs.length) continue;
      const aEdges = cellEdges(a);
      const bEdges = cellEdges(b);
      const aId = ids[i]!;
      const bId = ids[j]!;
      cs.forEach(({ edgeA, edgeB }) => {
        const tA = aEdges[edgeA]!;
        const tB = bEdges[edgeB]!;
        contactsByCell[aId]!.push({ otherId: bId, myEdge: edgeA, myType: tA, otherType: tB });
        contactsByCell[bId]!.push({ otherId: aId, myEdge: edgeB, myType: tB, otherType: tA });
        if (tA === 'arm' && tB === 'arm') {
          violations.push({ aId, bId, reason: 'Arm-to-arm' });
        } else if (tA === 'arm' || tB === 'arm') {
          violations.push({ aId, bId, reason: 'Arm blocked by module' });
        }
      });
    }
  }

  const outwardArms: { edge: EdgeIdx; lCap?: boolean }[] = [];
  const unclosedByDir: Record<EdgeIdx, boolean> = {
    [EDGE_W]: false, [EDGE_N]: false, [EDGE_E]: false, [EDGE_S]: false,
  };
  group.forEach((c, i) => {
    const id = ids[i]!;
    const edges = cellEdges(c);
    const myContacts = contactsByCell[id]!;
    const isL = c.moduleId.startsWith('L(');
    const isAcc = isAccessoryModule(c.moduleId);

    const lCapEdge = lCapEdgeOf(c.moduleId, c.rot);

    ([EDGE_W, EDGE_N, EDGE_E, EDGE_S] as EdgeIdx[]).forEach((e) => {
      const hasNeighbour = myContacts.some((co) => co.myEdge === e);
      if (hasNeighbour) return;
      if (isL && e === lCapEdge) {
        outwardArms.push({ edge: e, lCap: true });
        return;
      }
      const t = edges[e];
      if (t === 'arm') {
        outwardArms.push({ edge: e });
      } else if (t === 'open' && !isAcc) {
        unclosedByDir[e] = true;
      }
    });
  });

  let bbW = 0, bbH = 0;
  if (group.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of group) {
      const b = cellBbox(c, depth);
      if (!b) continue;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    if (Number.isFinite(minX)) {
      bbW = maxX - minX;
      bbH = maxY - minY;
    }
  }

  let headArm = false;
  let tailArm = false;
  if (group.length > 0) {
    const horizontalDominant = bbW >= bbH;
    if (horizontalDominant) {
      headArm = outwardArms.some((a) => a.edge === EDGE_W);
      tailArm = outwardArms.some((a) => a.edge === EDGE_E);
    } else {
      headArm = outwardArms.some((a) => a.edge === EDGE_N);
      tailArm = outwardArms.some((a) => a.edge === EDGE_S);
    }
  }

  const ends = headArm && tailArm;
  const hasUnclosedOpen =
    unclosedByDir[EDGE_W] || unclosedByDir[EDGE_N] ||
    unclosedByDir[EDGE_E] || unclosedByDir[EDGE_S];
  let closed = violations.length === 0 && ends && !hasUnclosedOpen;
  let reason: ClosureFailure | null = null;
  if (violations.length > 0) reason = 'Arms colliding';
  else if (!headArm && !tailArm) reason = 'No arms on either end';
  else if (!headArm) reason = bbW >= bbH ? 'Left end has no arm' : 'Top end has no arm';
  else if (!tailArm) reason = bbW >= bbH ? 'Right end has no arm' : 'Bottom end has no arm';
  else if (hasUnclosedOpen) {
    if (unclosedByDir[EDGE_W])      reason = 'Left end has no arm';
    else if (unclosedByDir[EDGE_E]) reason = 'Right end has no arm';
    else if (unclosedByDir[EDGE_N]) reason = 'Top end has no arm';
    else if (unclosedByDir[EDGE_S]) reason = 'Bottom end has no arm';
  }

  const allAccessories = group.length > 0 && group.every((c) => isAccessoryModule(c.moduleId));
  if (allAccessories) {
    const everyPieceStandsAlone = group.every((c) => c.moduleId === 'STOOL');
    closed = everyPieceStandsAlone;
    reason = everyPieceStandsAlone ? null : 'Console needs a sofa next to it';
  }

  return { violations, closed, reason, leftArm: headArm, rightArm: tailArm };
};


/**
 * One line item for the supplier's purchase order. `sku` is what the
 * factory's SKU sheet uses; `label` is human-readable for the printable PO.
 */
export interface PoSkuLine {
  sku: string;
  label: string;
  qty: number;
}

/**
 * Translate a custom-build sofa's cells into PO line items.
 *
 * Bundle-first rule (per Loo, 2026-05-16): when a group of cells forms a
 * recognised BUNDLE (`1S` / `2S` / `3S` / `2+L` / `3+L`, including alt-form
 * compositions like `1A+1A → 2S`), the PO emits ONE line with the bundle
 * id as the SKU — that's what the factory stocks as an assembled product.
 * When the cells form an ad-hoc shape with no bundle match, each cell is
 * emitted as its own SKU line so the factory can pick the right
 * compartments and assemble.
 *
 * Multi-sofa carts: a single configurator session can place 2+ separate
 * sofas in one room (e.g. main 3-seater + side 1-seater). Each
 * adjacency-connected group becomes its own bundle/cell translation.
 *
 * Accessories (`WC-45` etc.) ship as their own SKU since they're standalone
 * pieces that just happen to be adjacent to a sofa for layout purposes.
 *
 * @param cells   the SofaConfigSnapshot.cells from order_items.config
 * @param depth   the configured seat depth (24″ or 28″)
 * @returns       one PoSkuLine per bundle / per ad-hoc cell, qty always 1
 *                (multiply by order_item.qty at the caller)
 */
export const cellsToPoSkus = (cells: Cell[], depth: Depth): PoSkuLine[] => {
  if (cells.length === 0) return [];
  const groups = groupSofas(cells, depth);
  const out: PoSkuLine[] = [];
  for (const group of groups) {
    const sofaCells: Cell[] = [];
    for (const c of group) {
      if (isAccessoryModule(c.moduleId)) {
        const m = findModule(c.moduleId);
        out.push({ sku: c.moduleId, label: m?.label ?? c.moduleId, qty: 1 });
      } else {
        sofaCells.push(c);
      }
    }
    if (sofaCells.length === 0) continue;

    const modIds = sofaCells.map((c) => c.moduleId);
    const bundle = detectBundle(modIds);
    if (bundle) {
      out.push({ sku: bundle.id, label: bundle.label, qty: 1 });
    } else {
      for (const c of sofaCells) {
        const m = findModule(c.moduleId);
        out.push({ sku: c.moduleId, label: m?.label ?? c.moduleId, qty: 1 });
      }
    }
  }
  return out;
};

/* ─── ORDER FOR A SOFA THAT HAS NO GEOMETRY (owner, 2026-08-28) ───────────
 *
 * 「排版都要从L开始啊 Left to right」, and then the sharper version:
 * 「这个的问题是跟着 SKU 排版下来…所以我们只需要 control SKU 的顺序」.
 *
 * `orderSofaCellsLeftToRight` above sorts by real x/y and DELIBERATELY keeps the
 * stored order when the coordinates are missing — it refuses to guess. That is
 * right for a POS build, where the customer placed the furniture. It leaves one
 * case unanswered: a sofa built in the ERP (SO New / Maintenance) never had
 * geometry, so its modules stay in whatever order somebody typed them. A
 * purchase order listing `L(RHF)` before `2A(LHF)` then draws the right-hand
 * chaise on the LEFT — and the drawing is not wrong about its input; the input
 * is wrong about the sofa.
 *
 * The codes already carry the answer: `(LHF)` is left-hand facing, so it IS the
 * left end; `(RHF)` the right; anything with neither (1NA, 2NA, CNR, Console,
 * STOOL) is an armless middle and keeps its place between them.
 *
 * WHY THIS IS A SEPARATE FUNCTION AND NOT A NEW BRANCH IN THE ONE ABOVE. That
 * one is called at DISPLAY time as well (so-line-display, the label builder), so
 * teaching it to reorder would silently re-sequence every EXISTING order's lines
 * the next time anyone looked at them. The owner drew that line himself:
 * 「只针对新的order生效 旧的就不理了」. This is used at LINE-CREATION time only.
 *
 * Stable: two LHF pieces keep the order the caller gave them, because nothing
 * distinguishes them and the caller's order is then the only evidence there is.
 */
const SOFA_HANDS = ['LHF', 'MID', 'RHF'] as const;
type SofaHand = (typeof SOFA_HANDS)[number];
const SOFA_HAND_RANK = new Map<SofaHand, number>(SOFA_HANDS.map((h, i) => [h, i]));

/** Which end of a sofa a module code belongs to, by the supplier convention. */
export const sofaModuleHand = (moduleId: string): SofaHand => {
  const id = String(moduleId).toUpperCase();
  if (id.includes('(LHF)')) return 'LHF';
  if (id.includes('(RHF)')) return 'RHF';
  return 'MID';
};

/**
 * Left-to-right order for cells ABOUT TO BECOME LINES. Uses real geometry when
 * there is any; falls back to the handedness the codes carry when there is not,
 * instead of keeping an order nobody chose.
 */
export const orderSofaCellsForNewLines = (cells: Cell[], depth: Depth): Cell[] => {
  if (cells.length <= 1) return cells.slice();

  /* THE SUFFIX IS THE DIRECTION, and the owner said so in as many words when I
     had built it the other way round (2026-08-28: 「我们是看后面的 LHF RHF 啊
     这才是方向」). So handedness decides FIRST and geometry only settles ties.

     The two normally agree — the configurator decomposes a sofa as
     "2A(LHF) + L(RHF)", laid out in that order — so this changes nothing for a
     POS build in the ordinary case. Where they CAN disagree is a customer who
     deliberately placed an (RHF) piece on the left: the plan still draws the
     real placement, because it is drawn from x/y, while the LINES list by
     handedness. That mismatch is the owner's call, made knowingly. */
  const ranked = cells
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      ((SOFA_HAND_RANK.get(sofaModuleHand(a.c.moduleId)) ?? 1)
        - (SOFA_HAND_RANK.get(sofaModuleHand(b.c.moduleId)) ?? 1))
      || (a.i - b.i));

  const byHand = new Map<SofaHand, Cell[]>();
  for (const { c } of ranked) {
    const h = sofaModuleHand(c.moduleId);
    const list = byHand.get(h);
    if (list) list.push(c); else byHand.set(h, [c]);
  }
  const out: Cell[] = [];
  for (const hand of SOFA_HANDS) {
    const group = byHand.get(hand);
    if (!group) continue;
    const placed = group.every(
      (c) => typeof c.moduleId === 'string' && Number.isFinite(c.x) && Number.isFinite(c.y),
    );
    out.push(...(placed && group.length > 1 ? orderSofaCellsLeftToRight(group, depth) : group));
  }
  return out;
};
