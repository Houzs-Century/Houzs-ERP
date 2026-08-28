// Sofa build / configurator pure functions. Lifted from prototype
// pos-sofa-config.jsx + pos-data.jsx. Phase 2 step A — pricing math + grouping +
// adjacency. analyzeSofa closure validation deferred to step B.
//
// All functions are pure (no DOM, no module-level state). Depth & per-Model
// pricing flow through arguments. Same code runs on POS, Backend preview,
// and Cloudflare Workers when /orders does the server-side recompute.

import { pickComboMatch, type SofaComboRow, type SofaPriceTier } from './sofa-combo-pricing';
export type { SofaComboRow } from './sofa-combo-pricing';
export { comboChargedPrices } from './sofa-combo-pricing';
// One-way edge: mfg-pricing.ts imports nothing (fully self-contained), so this
// does NOT create a cycle. resolveSeatHeightSelling powers the SELLING assembly
// helper below; MfgSeatHeightPrice is the per-(height,tier) entry shape.
import { resolveSeatHeightSelling, resolveSeatHeightSen, type MfgSeatHeightPrice, type MfgFabricTier } from './mfg-pricing';

/* ─── Public types ─────────────────────────────────────────────────── */

export type Rot = 0 | 90 | 180 | 270;
// Seat depth in inches, as a string (e.g. '24', '28', '30', '32'). Was a
// '24'|'28' union; widened (F5) so the configurator can offer each Model's real
// depths from products.depth_options. Display + plan-view width only — never a
// pricing dimension.
export type Depth = string;

export interface Cell {
  /** Optional client-side cell id for grouping by reference. */
  id?: string;
  moduleId: string;
  x: number;
  y: number;
  rot: Rot;
  /** Per-seat recliner upgrades. seatIdx 0-based, left-to-right at rot=0. */
  recliners?: { seatIdx: number; open: boolean }[];
}

export interface SofaModuleSpec {
  id: string;
  group: '1-seater' | '2-seater' | '3-seater' | 'Corner' | 'L-Shape' | 'Accessory';
  label: string;
  /** Width along the cushion axis (cm), 24″ baseline. */
  w: number;
  /** Depth (cm). */
  d: number;
  cushions: number;
  accessory?: boolean;
}

export interface SofaProductPricingRow {
  compartmentId: string;
  active: boolean;
  /** SEN. Was whole MYR until 2026-08-14; the rename is deliberate so that a
   *  missed call site fails to compile instead of being silently 100x off. */
  priceSen: number;
}
export interface SofaProductPricingBundle {
  bundleId: string;
  active: boolean;
  /** SEN — see SofaProductPricingRow.priceSen. */
  priceSen: number;
}
export interface SofaProductPricing {
  compartments: SofaProductPricingRow[];
  bundles: SofaProductPricingBundle[];
  /** SEN — see SofaProductPricingRow.priceSen. */
  reclinerUpgradeSen: number;
  /** Per-Model name for the per-seat upgrade ('Power slide','Headrest', …).
   *  null/undefined → this Model offers no per-seat upgrade (POS hides the add
   *  button). Display only — the upgrade price is `reclinerUpgradeSen`.
   *  F3, 2026-05-23 (migration 0039). */
  seatUpgradeLabel?: string | null;
  /** true → upgraded seat opens a footrest (power recliner/incliner/slide/leg);
   *  false → no footrest (headrest). Defaults to true when omitted. */
  seatUpgradeFootrest?: boolean;
  /** Per-Model fabric availability + surcharge (spec 2026-05-24). Optional so
   *  callers that don't price fabric (e.g. plan-view) can omit it.
   *  `computeSofaPrice` ignores this — surcharge is a caller-applied line add. */
  fabrics?: SofaProductPricingFabric[];
  /** Sofa Combo Pricing rows (Commander 2026-05-28). When the group's modules
   *  + tier match a combo row's modules + tier, the combo price OVERRIDES the
   *  à la carte / bundle pricing. Pass [] to disable; pass a SofaComboRow[]
   *  fetched per-call to enable. The picker is tolerant of empty baseModel
   *  (POS doesn't have the retail↔mfg base_model bridge yet — relies on
   *  modules-match alone). */
  combos?: import('./sofa-combo-pricing').SofaComboRow[];
  /** Fabric tier of the currently-selected fabric (PRICE_1 / PRICE_2 / PRICE_3).
   *  Used when looking up a combo override. Combos with tier=null match any
   *  tier; combos with a specific tier require an exact match. */
  fabricTier?: import('./sofa-combo-pricing').SofaPriceTier | null;
  /** Seat height as combos store it (e.g. '24'). Defaults to the depth param
   *  cast as string when omitted. */
  comboHeight?: string;
  /** Base model code for combo lookup. POS sets to '' for wildcard match. */
  baseModel?: string;
}

export interface SofaProductPricingFabric {
  fabricId: string;
  active: boolean;
  surcharge: number;
  /** Active colour ids for this fabric — the server uses them to validate the
   *  chosen colour. Display labels/hex are loaded separately for the UI. */
  colourIds: string[];
}

export interface BundleDef {
  id: string;
  label: string;
  /** Canonical detection signature — sorted family multiset, e.g. '2A+1NA+L'.
   * Additional equivalent signatures (e.g. customer-assembled variants that
   * form the same shape) are registered in BUNDLE_BY_SIG. */
  signature: string;
  /** Canonical SKU composition for invoice / PO line items. When a customer's
   * build matches this bundle, the cart represents the sofa as this list of
   * compartments so the backend can issue a PO that the factory understands
   * (each entry is a real orderable SKU, not the loose set of modules the
   * customer happened to drag onto the canvas). Family ids only — actual
   * LHF/RHF orientation is derived from the laid-out cells at swap time. */
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
  /** What the customer pays for this group. min(bundle, à la carte) + recliners. */
  finalPrice: number;
  /** Where finalPrice came from. */
  basis: 'combo' | 'bundle' | 'a_la_carte';
  /** When basis='combo', the matched combo's price for the current height
   *  (before recliner extras). This covers ONLY the matched subset of cells.
   *  null otherwise. */
  comboPrice?: number | null;
  /** When basis='combo', the à-la-carte sum of the SUBSET the combo replaced
   *  (HOOKKA's subsetSum). null otherwise. */
  comboSubsetALaCarte?: number | null;
  /** When basis='combo', the à-la-carte sum of the EXTRA cells outside the
   *  matched subset — they stay at full master price and are added on top of
   *  the combo price. 0 when the combo covered the whole group. null when
   *  basis !== 'combo'. */
  comboExtrasALaCarte?: number | null;
  /** When basis='combo', the cellIds of the matched subset (the cells the
   *  combo price covers). Extras = cellIds − comboMatchedCellIds. Lets the
   *  cart show "combo applied + extras separate" like HOOKKA. null otherwise. */
  comboMatchedCellIds?: string[] | null;
}

export interface SofaPriceResult {
  groups: SofaGroupPrice[];
  total: number;
}

/* ─── Module catalogue ─────────────────────────────────────────────── */
// 24″ baseline. 28″ depth adds 10cm × cushions to the .w (length) axis only.

// Module ids use the PARENS form — the ONE canonical compartment vocabulary
// shared with the Maintenance master pool, Modular allowed-options, mfg SKU
// suffixes ({MODEL}-1A(LHF)) and SO descriptions (Loo 2026-06-04: "one name
// everywhere, no translating here and there"). The legacy dash form
// (1A-LHF) survives only inside normalizeCompartmentCode for tolerance.
export const SOFA_MODULES: readonly SofaModuleSpec[] = [
  // 1-seaters (LHF/RHF = left/right hand facing — supplier convention)
  { id: '1A(LHF)', group: '1-seater',  label: '1A · Left hand facing',  w: 95,  d: 95,  cushions: 1 },
  { id: '1A(RHF)', group: '1-seater',  label: '1A · Right hand facing', w: 95,  d: 95,  cushions: 1 },
  { id: '1B(LHF)', group: '1-seater',  label: '1B · Left hand facing (wide arm)',  w: 105, d: 95, cushions: 1 },
  { id: '1B(RHF)', group: '1-seater',  label: '1B · Right hand facing (wide arm)', w: 105, d: 95, cushions: 1 },
  { id: '1NA',    group: '1-seater',  label: '1NA · No arms',          w: 75,  d: 95,  cushions: 1 },
  // 2-seaters
  { id: '2A(LHF)', group: '2-seater',  label: '2A · Left hand facing',  w: 158, d: 95,  cushions: 2 },
  { id: '2A(RHF)', group: '2-seater',  label: '2A · Right hand facing', w: 158, d: 95,  cushions: 2 },
  { id: '2B(LHF)', group: '2-seater',  label: '2B · Left hand facing (wide arm)',  w: 170, d: 95, cushions: 2 },
  { id: '2B(RHF)', group: '2-seater',  label: '2B · Right hand facing (wide arm)', w: 170, d: 95, cushions: 2 },
  { id: '2NA',    group: '2-seater',  label: '2NA · No arms',          w: 142, d: 95,  cushions: 2 },
  // Corner — single SKU per supplier; canvas rotation orients NW/NE/SE/SW.
  { id: 'CNR',    group: 'Corner',    label: 'Corner piece',           w: 95,  d: 95,  cushions: 1 },
  // L-shape chaise
  { id: 'L(LHF)',  group: 'L-Shape',   label: 'L · Left hand facing chaise',  w: 95, d: 165, cushions: 1 },
  { id: 'L(RHF)',  group: 'L-Shape',   label: 'L · Right hand facing chaise', w: 95, d: 165, cushions: 1 },
  // Accessory — 45cm wood console. Slots between sofa pieces; doesn't count
  // toward bundles or closure.
  { id: 'Console', group: 'Accessory', label: 'Wood console · 45cm',    w: 45,  d: 95,  cushions: 0, accessory: true },
  // Ottoman / stool — 75×75 free-standing accessory (F1). Doesn't count toward
  // bundles or closure. Art: STOOL.png (Loo provides).
  { id: 'STOOL',  group: 'Accessory', label: 'Ottoman / stool',        w: 75,  d: 75,  cushions: 0, accessory: true },
  // Pool-sourced first-class compartments (2026-06-01). Whole-unit presets carry
  // both end arms; functional 1-seater variants (P=power, R=recliner, L=power leg)
  // keep the base 1A/1NA closed footprint. Approx dims — Chairman adjusts later.
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
  // 1-Seater (both arms) functional variants — 1S body + forward footrest.
  { id: '1S(P)', group: '1-seater', label: '1S · Power · Both arms',     w: 115, d: 95, cushions: 1 },
  { id: '1S(R)', group: '1-seater', label: '1S · Recliner · Both arms',  w: 115, d: 95, cushions: 1 },
  { id: '1S(L)', group: '1-seater', label: '1S · Power leg · Both arms', w: 115, d: 95, cushions: 1 },
];

const MODULE_BY_ID = new Map<string, SofaModuleSpec>(SOFA_MODULES.map((m) => [m.id, m]));

/* ─── Structural fallback (Maintenance-is-master, Loo 2026-06-04) ───────
 *
 * A compartment code RENAMED on the Maintenance master pool cascades through
 * every stored copy (rename_sofa_compartment, migration 0149) — but the
 * canvas still needs to know the shape. As long as the rename keeps the
 * STRUCTURE tokens — base family (1A/1B/2A/2B/1NA/2NA/1S/2S/3S/CNR/L/
 * Console/STOOL), optional (LHF)/(RHF) orientation, optional (P)/(R)/(L)
 * mechanism — `findModule` synthesizes a spec from the family's canonical
 * geometry and `cellEdges` derives the arm sides the same way, so e.g.
 * '1A(LHF)(28)' or a re-cased '1a(lhf)' keeps rendering, pricing and
 * closing exactly like '1A(LHF)'. A base the structure parser doesn't know
 * still returns undefined: a brand-new physical module needs real dims +
 * art, which is dev work by design. */

export interface CompartmentStructure {
  /** Upper-cased base family token, e.g. '1A', '2NA', 'CNR', 'CONSOLE'. */
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

/** Canonical representative id per structure — geometry + edges come from
 *  this id's SOFA_MODULES / MODULE_EDGES_BASE entry. */
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

/* ─── Compartment code canonicalizer (unified 2026-06-04) ──────────────
 *
 * The ONE compartment vocabulary is the PARENS form (`1A(LHF)`,
 * `1A(P)(LHF)`) — same as the Maintenance master pool, Modular
 * allowed-options, mfg SKU suffixes and SO descriptions.
 * `normalizeCompartmentCode` canonicalizes any input to that form, so a
 * stray legacy dash code (`1A-LHF` from a pre-migration snapshot or a
 * free-typed Maintenance entry) still resolves to the same module. It is
 * an input spell-checker at the boundary — NOT a display translation; the
 * canonical form IS what renders everywhere.
 *
 * `classifySofaCompartment` groups a code into the POS palette buckets so
 * CustomBuilder can build "1-SEATER / 2-SEATER / CORNER / L-SHAPE / OTHER"
 * sections from the Model's allowed-options list. Mirrors SOFA_MODULES.group
 * for codes the shared lib already knows about; unknown pool codes fall
 * back to a prefix heuristic so they still show up under the right header.
 * ─────────────────────────────────────────────────────────────────────── */

export const normalizeCompartmentCode = (raw: string): string => {
  // Collapse any parens/dash mix down to dash tokens first, then re-emit
  // the canonical parens form: base token + each following token wrapped.
  // '1A-LHF' → '1A(LHF)'; '1A(P)-LHF' → '1A(P)(LHF)'; '1NA' → '1NA';
  // codes with no dash/parens structure ('Console', 'STOOL') pass through.
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
  // Heuristic fallback for codes outside SOFA_MODULES (recliner variants,
  // Console alias, etc.). Matches the descriptions in
  // COMPARTMENT_DESCRIPTION_OVERRIDE on the Backend side.
  if (/^L[-(]/i.test(norm) || /^L$/i.test(norm)) return 'L-Shape';
  if (/^CNR$/i.test(norm) || /^CORNER/i.test(norm)) return 'Corner';
  if (/^STOOL|^Console|^WC-/i.test(norm)) return 'Accessory';
  if (/^2/.test(norm)) return '2-seater';
  if (/^1/.test(norm)) return '1-seater';
  return 'Other';
};

/* ─── Mirror helpers (Quick Pick L↔R flip, 2026-06-01) ───────────────────
 * Flip a saved Quick Pick layout left↔right: reverse the slot order and swap
 * each handed code's LHF↔RHF. Codes with no orientation (1NA, 2NA, Console,
 * CNR, STOOL, power variants without a hand) pass through unchanged. Works on
 * BOTH the dash form (`2A-LHF`) and the parens form (`1A(P)(LHF)`) because
 * LHF/RHF only ever appear as the orientation token, never both in one code. */
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

/* ─── SELLING helpers (per-Model module-SKU prices — SOFA-SELLING-PLAN.md,
 * Chairman 2026-05-31) ───────────────────────────────────────────────────
 * A configured mfg sofa is priced from the Model's per-module SELLING prices.
 * Each module of each Model is its own mfg SKU (e.g. Booqit's 2A(LHF) → SKU
 * `BOOQIT-2A(LHF)`), and that SKU's `sell_price_sen` IS the per-Model module
 * price (Master Admin sets it). Custom builds sum each module's price; a
 * matched Combo overrides (always — Q2). The POS (so a custom build is no
 * longer RM0) and the server selling recompute (so its drift-reject matches
 * the POS by construction) both build the SAME per-Model module→price map
 * through these pure helpers — same source, same math, zero divergence. */

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
export const computeSofaSellingSen = (
  cells: Cell[],
  depth: Depth,
  modulePrices: SofaModulePriceSen | null | undefined,
  combos: SofaComboRow[],
): number => {
  const pricing: SofaProductPricing = {
    compartments: sofaCompartmentsFromModulePrices(modulePrices),
    bundles: [],
    reclinerUpgradeSen: 0,
    combos,
    // Match combos at PRICE_1 — the base tier the whole sofa runs at (Chairman
    // 2026-06-01). Module seat prices load at PRICE_1 and every combo is
    // authored at PRICE_1, so the POS (Configurator sofaPricing) and this
    // server drift gate MUST agree on PRICE_1; querying PRICE_2 here would make
    // the server price à-la-carte while the POS applied the combo → false drift
    // reject on POST /orders.
    fabricTier: 'PRICE_1',
    comboHeight: String(depth),
    baseModel: '',
  };
  return computeSofaPrice(cells, depth, pricing).total;
};

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

/* ─── Recliner eligibility ─────────────────────────────────────────── */

// Structure-based (Maintenance-is-master): a plain armed/armless seat is
// recliner-upgradeable; whole-unit presets (1S/2S/3S), accessories, L-shape
// and seats that ALREADY carry a (P)/(R)/(L) mechanism are not. Survives a
// Maintenance rename that keeps the family + orientation tokens.
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

/* ─── Bundle catalogue + auto-detect ───────────────────────────────── */
// Family = the base token before the first "(" (1A(LHF) → 1A). Used for the
// multiset signature that bundles match against. Accessories drop out before
// signing.

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

// For bundle detection only: 1B (wide-arm 1-seater) and 1A are the same
// shape, just different arm widths; same for 2B vs 2A. Collapsing them at
// detection time lets a 1A+1B custom build match the 2S bundle without
// listing every armed-variant combination explicitly.
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

// Canonical SKU composition per bundle. These are the line items the factory
// orders against — same physical sofa as the customer's drag-out, but
// expressed as the SKUs the supplier stocks. e.g. a customer who built a
// 2-seater out of two armed 1-seaters (1A+1A) ships as one 2-seater
// compartment (2A) on the PO.
export const BUNDLES: readonly BundleDef[] = [
  { id: '1S',  label: '1-Seater', signature: '1A',       canonicalModules: ['1A'] },
  { id: '2S',  label: '2-Seater', signature: '2A',       canonicalModules: ['2A'] },
  // 2.5-Seater — a widened 2-seater sold via Quick Pick only (Loo 2026-05-23).
  // No distinct module/art: the POS reuses 2S.png rendered wider (see
  // Configurator QUICK_PRESET_META + bundleArtSrc). The signature is an
  // intentionally non-matchable family ('2.5A') so detectBundle never
  // auto-selects it from a custom build — there is no 2.5A module to compose.
  { id: '2.5S',label: '2.5-Seater',signature: '2.5A',    canonicalModules: ['2A'] },
  { id: '3S',  label: '3-Seater', signature: '1A+2A',    canonicalModules: ['1A', '2A'] },
  { id: '2+L', label: '2 + L',    signature: '2A+L',     canonicalModules: ['2A', 'L'] },
  { id: '3+L', label: '3 + L',    signature: '1NA+2A+L', canonicalModules: ['2A', '1NA', 'L'] },
  // 2-Seater + Console (F6) — two single-arm 1-seaters flanking a wood console,
  // Quick-Pick only. Non-matchable signature so a custom 1A+WC+1A never
  // auto-detects as this priced preset.
  { id: '2WC', label: '2-Seater + Console', signature: '2WC-PRESET', canonicalModules: ['1A', 'Console', '1A'] },
  // 2-Seater + 2 Power slide combo (F7, DSL 8027) — a 2-seater sold as a fixed
  // Quick-Pick at the combo price; per-seat power slide stays available in Custom
  // Build too. Label IS the invoice text. Non-matchable signature.
  { id: '2PS', label: '2-Seater + 2 Power slide', signature: '2PS-PRESET', canonicalModules: ['2A'] },
  // Corner package (F4, 5539) — 1A + corner + 2A, Quick-Pick only, composed
  // preview (no composite PNG). Non-matchable signature.
  { id: 'CORNER', label: 'Corner', signature: 'CORNER-PRESET', canonicalModules: ['1A', 'CNR', '2A'] },
];

// Each entry is a signature → bundle. Multiple signatures map to the same
// bundle when distinct compartment compositions form the same shape:
//   - 2S: '2A' (canonical) OR '1A+1A' (two armed 1-seaters)
//   - 3S: '1A+2A' (canonical) OR '1A+1A+1NA' (three 1-seaters, middle no-arm)
//   - 3+L: '2A+1NA+L' (canonical) OR '1A+2NA+L' (legacy) OR '1A+1A+1NA+L'
// Closure (proper arm at each end) is enforced separately by groupPrice via
// analyzeSofa — invalid layouts like two LHF modules adjacent share the
// '1A+1A' signature but fail closure and fall back to à la carte pricing.
const BY_2S = '2S' as const;
const BY_3S = '3S' as const;
const BY_2L = '2+L' as const;
const BY_3L = '3+L' as const;
const BUNDLE_BY_SIG = new Map<string, BundleDef>([
  ...BUNDLES.map((b) => [b.signature, b] as const),
  ['1A+1A',         BUNDLES.find((b) => b.id === BY_2S)!],
  ['1A+1A+1NA',     BUNDLES.find((b) => b.id === BY_3S)!],
  ['1A+1A+L',       BUNDLES.find((b) => b.id === BY_2L)!],
  ['1A+2NA+L',      BUNDLES.find((b) => b.id === BY_3L)!],  // legacy/equivalent shape
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
  /** Per-Model upgrade label — when set AND any seat is upgraded, the summary
   *  gets a "+ N <label>" suffix (e.g. "2-Seater + 2 Power slide"). Omitted by
   *  callers that lack pricing in hand; then no suffix is added. F3 2026-05-23. */
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

/* ─── Invoice / order line description (Track 2 §8.1) ──────────────── */
// Single-piece bundles (1S/2S/2.5S) show the bundle name; multi-piece bundles
// (3S/2+L/3+L/corner/console) decompose to oriented module ids. Reads the
// persisted order_items.config (bundleId = Quick-Pick, cells = Custom Build).
// Display only — never used for pricing.

const SINGLE_PIECE_BUNDLES = new Set(['1S', '2S', '2.5S']);

// Canonical oriented decomposition for a Quick-Pick bundle (no cells to read).
// Outer arms face out (leftmost LHF, rightmost RHF); mirror is equally valid
// (Loo 2026-05-24). Keyed by bundle id; single-piece bundles aren't listed here
// (they render as their name).
const BUNDLE_INVOICE_DECOMP: Record<string, string> = {
  '3S':  '1A(LHF) + 2A(RHF)',
  '2+L': '2A(LHF) + L(RHF)',
  '3+L': '2A(LHF) + 1NA + L(RHF)',
  // Console (F6): two single-arm 1-seaters flanking a wood console.
  '2WC': '1A(LHF) + Console + 1A(RHF)',
  // Corner package (F4, 5539): 1A + corner + 2A (1A is the chaise leg).
  'CORNER': '1A(LHF) + CNR + 2A(RHF)',
};

const bundleLabelById = (bundleId: string): string =>
  BUNDLES.find((b) => b.id === bundleId)?.label ?? bundleId;

// Seats in a bundle, from its canonical module families (1x → 1, 2x → 2, L/CNR → 0).
// Counts auto-included headrests on a quick-pick (F3).
const bundleSeatCount = (bundleId: string): number => {
  const b = BUNDLES.find((x) => x.id === bundleId);
  if (!b) return 0;
  return b.canonicalModules.reduce(
    (n, fam) => n + (fam.startsWith('2') ? 2 : fam.startsWith('1') ? 1 : 0),
    0,
  );
};

export interface SofaLineDescriptor {
  /** Quick-Pick: the chosen bundle id. */
  bundleId?: string;
  /** Custom Build: the laid-out cells (module ids already carry orientation). */
  cells?: Cell[];
  depth?: Depth;
  /** Per-Model upgrade label snapshot; suffixes "+ N <label>" when seats upgraded. */
  seatUpgradeLabel?: string | null;
  /** Upgrade footrest flag. false = auto-included (headrest) → shown on a quick-pick
   *  as "+ N <label>" (N = seat count). true/undefined = opt-in power upgrade added
   *  per seat in Custom Build, NOT auto-appended on quick-pick. F3. */
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
    // Auto-included non-footrest upgrade (headrest) → "+ N <label>" (N = seat count).
    // Opt-in footrest upgrades (power) are added per seat in Custom Build, not here.
    if (cfg.seatUpgradeLabel && cfg.seatUpgradeFootrest === false) {
      const n = bundleSeatCount(cfg.bundleId);
      if (n > 0) return `${base} + ${n} ${cfg.seatUpgradeLabel}`;
    }
    return base;
  }

  return 'Sofa';
};

/* ─── Edge typing & rotation ───────────────────────────────────────── */

export type EdgeType = 'arm' | 'open' | 'back' | 'front';
export type EdgeIdx = 0 | 1 | 2 | 3; // [W, N, E, S]
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
  // CNR base orientation = NW (arms on N+W). Other orientations come from canvas rot.
  'CNR':    ['arm',  'arm',  'open', 'open'],
  'L(LHF)':  ['open', 'back', 'open', 'front'],
  'L(RHF)':  ['open', 'back', 'open', 'front'],
  'Console':['open', 'open', 'open', 'open'],
  'STOOL':  ['open', 'open', 'open', 'open'],
  // Whole-unit presets — both end arms so a lone unit self-closes; two placed
  // adjacent read as two separate armed units (arm-to-arm), priced individually.
  '1S': ['arm', 'back', 'arm', 'front'],
  '2S': ['arm', 'back', 'arm', 'front'],
  '3S': ['arm', 'back', 'arm', 'front'],
  // Functional 1-seater variants mirror their base 1A(LHF) / 1A(RHF) arm side.
  '1A(P)(LHF)': ['arm',  'back', 'open', 'front'],
  '1A(P)(RHF)': ['open', 'back', 'arm',  'front'],
  '1A(R)(LHF)': ['arm',  'back', 'open', 'front'],
  '1A(R)(RHF)': ['open', 'back', 'arm',  'front'],
  '1A(L)(LHF)': ['arm',  'back', 'open', 'front'],
  '1A(L)(RHF)': ['open', 'back', 'arm',  'front'],
  '1NA(P)': ['open', 'back', 'open', 'front'],
  '1NA(R)': ['open', 'back', 'open', 'front'],
  '1NA(L)': ['open', 'back', 'open', 'front'],
  // 1S functional variants carry both end arms, same as the plain 1S preset.
  '1S(P)': ['arm', 'back', 'arm', 'front'],
  '1S(R)': ['arm', 'back', 'arm', 'front'],
  '1S(L)': ['arm', 'back', 'arm', 'front'],
};

/** Clockwise 90° shifts [W,N,E,S] → [S,W,N,E]. */
const rotateEdges = (edges: EdgeType[], rot: Rot): EdgeType[] => {
  const r = ((rot % 360) + 360) % 360;
  const turns = r / 90;
  const out = edges.slice();
  for (let i = 0; i < turns; i++) out.unshift(out.pop()!);
  return out;
};

export const cellEdges = (cell: Cell): EdgeType[] => {
  // Structural fallback: a Maintenance-renamed code that kept its family +
  // orientation tokens derives its arm sides from the family representative.
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

/* ─── Footprint + bbox ─────────────────────────────────────────────── */

// Plan-view length grows with seat depth: 2.5cm per inch per cushion, anchored
// on the 24″ baseline (24→0, 28→+10, 30→+15, 32→+20). Non-numeric/below-baseline → 0.
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

/** Footrest extends 35cm out of the FRONT of a cell when an open recliner is present. */
const FOOTREST_CM = 35;
export const cellEffectiveBbox = (cell: Cell, depth: Depth): Bbox | null => {
  const b = cellBbox(cell, depth);
  if (!b) return null;
  const hasOpen = (cell.recliners ?? []).some((r) => r.open);
  if (!hasOpen) return b;
  const r = ((cell.rot % 360) + 360) % 360;
  // Front direction at rot=0 is S (+y). Each 90° CW rotation shifts:
  // 0→S, 90→W, 180→N, 270→E.
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

/* Translate a layout so its bounding box is centered within a `w`×`h` area
   (e.g. the CustomBuilder room). Pure translation — every cell shifts by the
   same delta, so relative geometry, grouping, pricing, and left-to-right order
   are all unchanged. A freshly-generated layout (cellsFromComboModules) is
   anchored at (0,0); without this it renders jammed into the top-left corner
   when handed to a room. Returns the cells unchanged when there's no
   measurable footprint. */
export const centerCellsWithin = (cells: Cell[], depth: Depth, w: number, h: number): Cell[] => {
  const bb = cellsBbox(cells, depth);
  if (!bb) return cells;
  const dx = w / 2 - bb.w / 2 - bb.x;
  const dy = h / 2 - bb.h / 2 - bb.y;
  return cells.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
};

/* ─── Adjacency + grouping ─────────────────────────────────────────── */

const CONTACT_TOL = 2; // cm — anything closer than this counts as touching.

interface EdgePair { edgeA: EdgeIdx; edgeB: EdgeIdx }

export const edgeContacts = (a: Cell, b: Cell, depth: Depth): EdgePair[] => {
  const ba = cellBbox(a, depth);
  const bb = cellBbox(b, depth);
  if (!ba || !bb) return [];
  const out: EdgePair[] = [];
  // a's right edge ↔ b's left edge
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

/** Two cells form ONE sofa only when they share a contact along a *connectable*
 *  edge — i.e. a SIDE ('arm' or 'open'). A module can only seam to another along
 *  its sides; its FRONT (seating side, where you sit) and its BACK (backrest)
 *  have no panel to attach to. So pieces that only ever touch front-to-anything
 *  (one shoved against another's seat-front) OR back-to-back (backrest against
 *  backrest) are two separate sofas, not one "Whole sofa". Every valid layout
 *  (straight run / L / U / corner) connects via sides, so nothing legit
 *  regresses. */
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

/* ─── Left-to-right cell order (Loo 2026-06-12) ────────────────────── */

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
    // Degenerate snapshots (legacy carts) can miss moduleId / coordinates —
    // keep the stored order rather than guess.
    if (typeof c.moduleId !== 'string' || !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      return cells.slice();
    }
    const b = cellBbox(c, depth);
    if (!b) return cells.slice(); // unknown module — keep the stored order
    boxes.set(c, b);
  }
  const inputIdx = new Map<Cell, number>(cells.map((c, i) => [c, i]));
  const centreX = (c: Cell): number => { const b = boxes.get(c)!; return b.x + b.w / 2; };
  const centreY = (c: Cell): number => { const b = boxes.get(c)!; return b.y + b.h / 2; };

  /** Stable visual fallback — the pre-walk (x, y) reading order. */
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
    const X_TIE = 1; // cm — same column ⇒ decide by code hand, then height
    const dx = centreX(group[a]!) - centreX(group[b]!);
    let start: number;
    // Hands are customer-facing truth (supplier convention): the LHF end IS
    // the customer's left no matter how the build is rotated on the canvas —
    // a north-facing (rot-180) build's canvas-left is the customer's RIGHT,
    // where canvas x would mislead. Opposite hands at the two ends decide
    // outright; geometry only arbitrates when the hands don't.
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

/* ─── Pricing ──────────────────────────────────────────────────────── */

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

  // À la carte total — sum compartment prices for every cell (active + inactive count;
  // an inactive comp shouldn't be in the cart in the first place, but if present we still
  // price it via its row's `price` so the customer-facing total never blows up).
  let aLaCarteTotal = 0;
  for (const cell of group) {
    // Mirror fallback (2026-06-01): a flipped Quick Pick swaps LHF↔RHF. If a
    // Model priced only one hand, resolve the other hand to the SAME row so a
    // mirrored sofa never prices to RM 0 or differs from its un-flipped twin.
    // Additive only — never lowers a priced module. POS + server share this
    // function, so the drift-reject on POST /orders can't fire from mirroring.
    const row = compRow(pricing, cell.moduleId)
      ?? compRow(pricing, mirrorCode(cell.moduleId));
    aLaCarteTotal += row?.priceSen ?? 0;
  }

  // Bundle candidate — if the assembled shape matches a known bundle AND the
  // bundle row is active AND the group is closed (proper arm at each end),
  // use the bundle price as the canonical retail for that shape. The bundle
  // is the "fixed complete sofa" price set in SKU master; à la carte sums of
  // individual compartments are a fallback for shapes that DON'T match a
  // bundle, not a price-shopping floor.
  //
  // Closure matters because the bundle-signature collapse (1B≡1A) means two
  // wrong-orientation 1-seaters (e.g. LHF+LHF) still produce the '1A+1A'
  // signature; closure rejects those layouts so they price à la carte.
  const candidate = detectBundle(modIds);
  let bundle: BundleDef | null = null;
  let bundlePrice: number | null = null;
  let basis: 'combo' | 'bundle' | 'a_la_carte' = 'a_la_carte';

  if (candidate) {
    const row = bundleRow(pricing, candidate.id);
    // Multi-module bundles need a closed layout (proper arm at each end) so
    // a customer can't dodge into bundle pricing with a nonsense layout like
    // two LHF modules adjacent. Single-module bundles ARE the module — a
    // 1A(LHF) is a left-armed 1-seater product, closed by definition.
    const closed = group.length === 1 || analyzeSofa(group, depth).closed;
    if (row && row.active && closed) {
      bundle = candidate;
      bundlePrice = row.priceSen;
      basis = 'bundle';
    }
  }

  // Combo override — Commander 2026-05-28, HOOKKA `comboMatches` 1:1. When a
  // SUBSET of the group's cells covers a Sofa Combo Pricing row's slots (with
  // a price at the current height), the combo price replaces that SUBSET's
  // à-la-carte total. Q2 (Chairman 2026-05-30): the combo applies whenever it
  // matches and is priced (> 0) — the cheaper-only guard was removed, so a
  // matched combo is the canonical price even if dearer than à-la-carte. The
  // EXTRA cells outside the matched subset keep their full master price.
  // Recliner extras still add on top.
  let comboPrice: number | null = null;
  let comboSubsetALaCarte: number | null = null;
  let comboExtrasALaCarte: number | null = null;
  let comboMatchedCellIds: string[] | null = null;
  if (pricing.combos && pricing.combos.length > 0) {
    const heightStr = pricing.comboHeight ?? String(depth);
    const match = pickComboMatch(
      {
        baseModel: pricing.baseModel ?? '',
        modules: modIds,
        customerId: null,        // 2990 B2C — only default-scope rows in play
        tier: pricing.fabricTier ?? 'PRICE_2',
        height: heightStr,
      },
      pricing.combos,
    );
    if (match) {
      // `match.comboPriceSen` is SEN, which IS sen — the combo dialog
      // stores `Math.round(rm * 100)`. Everything in groupPrice is sen now, so
      // it is carried straight through.
      //
      // This line used to read `Math.round(match.comboPriceSen / 100)`,
      // converting the combo total DOWN to whole MYR because the rest of the
      // object was whole-MYR. That is the defect: production carries 23
      // part-ringgit combo prices out of 163, so RM3152.63 billed as RM3153.00
      // and RM5712.11 as RM5712.00 — over- and under-charging, with margin
      // computed against a rounded revenue while cost stayed exact.
      // Ledger B4, answered by Actions -> "Sofa price rounding check".
      const comboPriceSen = match.comboPriceSen;
      // À-la-carte sum of the matched subset (the cells the combo replaces).
      // SEN — sums compartment `.priceSen`.
      const matchedSet = new Set(match.matchedIndices);
      let subsetSum = 0;
      for (let i = 0; i < group.length; i++) {
        if (!matchedSet.has(i)) continue;
        const cell = group[i]!;
        // Mirror fallback — SAME lookup as the à-la-carte loop above (audit
        // 2026-06-11 C1). Without it a matched cell priced only on the other
        // hand counts in aLaCarteTotal but not here, so comboExtrasALaCarte
        // (= aLaCarteTotal − subsetSum) wrongly re-charges that module ON TOP
        // of the combo price — a mirrored build paid combo + module twice.
        const row = compRow(pricing, cell.moduleId)
          ?? compRow(pricing, mirrorCode(cell.moduleId));
        subsetSum += row?.priceSen ?? 0;
      }
      // Q2 (Chairman 2026-05-30): the Master Account combo price is the
      // canonical price for a matched set — apply it whenever it matches and is
      // priced (> 0), even if the matched subset's à-la-carte sum is lower. The
      // former cheaper-only guard ("ignore equal / dearer combos") was removed
      // per the always-use-combo ruling. `comboSubsetALaCarte` is still recorded
      // for display, but no longer gates whether the combo applies.
      if (comboPriceSen > 0) {
        basis = 'combo';
        comboPrice = comboPriceSen;
        comboSubsetALaCarte = subsetSum;
        comboExtrasALaCarte = Math.max(0, aLaCarteTotal - subsetSum);
        comboMatchedCellIds = match.matchedIndices.map((i) => cellIds[i]!);
        // A combo match overrides the bundle path — clear bundle so
        // SofaGroupPrice.basis reads cleanly as 'combo'.
        bundle = null;
        bundlePrice = null;
      }
    }
  }

  // Recliner extras add on top regardless of basis.
  let reclinerCount = 0;
  for (const cell of group) {
    if (!reclinerEligible(cell.moduleId)) continue;
    reclinerCount += (cell.recliners ?? []).length;
  }
  const reclinerExtra = reclinerCount * pricing.reclinerUpgradeSen;

  // Base price by basis. For 'combo', the subset price + extras-at-full-price
  // (HOOKKA: comboTotal + Σ extras). For 'bundle' / à la carte, unchanged.
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

/* ─── Snap math (drag UI) ──────────────────────────────────────────── */

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

/* ─── Sofa analysis (closure / arm violations) ─────────────────────── */

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
  // Tracks edges of type 'open' that face outward (no neighbour) and aren't
  // covered by an arm or L-cap. Accessory cells (e.g. WC-45 console) are
  // exempt — their faces are 'open' by design and never get armrests.
  // An L-shape sofa whose bbox dominant axis is closed at both extremes can
  // STILL have an unclosed open cushion edge protruding off-axis (e.g. the
  // right end of an L's top row when the corner sits at the inside angle).
  // We need to flag that as not-closed even though head/tail pass.
  const unclosedByDir: Record<EdgeIdx, boolean> = {
    [EDGE_W]: false, [EDGE_N]: false, [EDGE_E]: false, [EDGE_S]: false,
  };
  group.forEach((c, i) => {
    const id = ids[i]!;
    const edges = cellEdges(c);
    const myContacts = contactsByCell[id]!;
    const isL = c.moduleId.startsWith('L(');
    const isAcc = isAccessoryModule(c.moduleId);

    // Outer cap of an L-chaise (rotation-aware) — shared with renderSeamlessGroup.
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
        // Outward 'open' edge with no arm/L-cap covering it. 'back' and
        // 'front' faces are by-design exposed (wall-side and seating-side
        // respectively) and don't fail closure.
        unclosedByDir[e] = true;
      }
    });
  });

  // Bounding box → dominant axis.
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
    // Head/tail axis is fine but an off-axis open edge is exposed (typical
    // L-shape with corner). Point the user at the first unclosed direction
    // we found, using the same vocabulary as the on-axis reasons.
    if (unclosedByDir[EDGE_W])      reason = 'Left end has no arm';
    else if (unclosedByDir[EDGE_E]) reason = 'Right end has no arm';
    else if (unclosedByDir[EDGE_N]) reason = 'Top end has no arm';
    else if (unclosedByDir[EDGE_S]) reason = 'Bottom end has no arm';
  }

  const allAccessories = group.length > 0 && group.every((c) => isAccessoryModule(c.moduleId));
  if (allAccessories) {
    // A stool / ottoman is free-standing — a stool-only group is a complete,
    // sellable piece on its own. The wood Console must slot beside a sofa, so
    // an accessory-only group that includes one is not a closed sofa.
    const everyPieceStandsAlone = group.every((c) => c.moduleId === 'STOOL');
    closed = everyPieceStandsAlone;
    reason = everyPieceStandsAlone ? null : 'Console needs a sofa next to it';
  }

  return { violations, closed, reason, leftArm: headArm, rightArm: tailArm };
};

/* ─── PO SKU translation ───────────────────────────────────────────── */

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
    // Split off accessories first — they never count toward bundle signature
    // and ship as their own SKU.
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
      // Ad-hoc layout: emit each cell as its own SKU line.
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
const SOFA_HAND_RANK: Record<'LHF' | 'MID' | 'RHF', number> = { LHF: 0, MID: 1, RHF: 2 };

/** Which end of a sofa a module code belongs to, by the supplier convention. */
export const sofaModuleHand = (moduleId: string): 'LHF' | 'MID' | 'RHF' => {
  const id = String(moduleId ?? '').toUpperCase();
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
      (SOFA_HAND_RANK[sofaModuleHand(a.c.moduleId)] - SOFA_HAND_RANK[sofaModuleHand(b.c.moduleId)])
      || (a.i - b.i));

  /* Within one hand — two LHF pieces, or several armless middles — the codes
     say nothing, so real geometry breaks the tie when there is any and the
     caller's own order does when there is not. */
  const byHand = new Map<'LHF' | 'MID' | 'RHF', Cell[]>();
  for (const { c } of ranked) {
    const h = sofaModuleHand(c.moduleId);
    const list = byHand.get(h);
    if (list) list.push(c); else byHand.set(h, [c]);
  }
  const out: Cell[] = [];
  for (const hand of ['LHF', 'MID', 'RHF'] as const) {
    const group = byHand.get(hand);
    if (!group) continue;
    const placed = group.every(
      (c) => typeof c.moduleId === 'string' && Number.isFinite(c.x) && Number.isFinite(c.y),
    );
    out.push(...(placed && group.length > 1 ? orderSofaCellsLeftToRight(group, depth) : group));
  }
  return out;
};
