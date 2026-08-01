// ----------------------------------------------------------------------------
// allowed-options-check — server-side enforcement of per-Model variant chips.
//
// PR #216 (Commander 2026-05-27 follow-up to the pricing-engine PR #205):
// allowedCompartments / allowedSeatSizes / allowedDivanHeights / etc.
// used to gate the UI only — commander could still hand-craft a POST that
// dropped a 2C(LHF) variant onto a Model that explicitly allowed only
// 1A(LHF) + 2A(LHF). The pricing engine would happily price it; the SO
// would persist; nobody complained until the production floor pushed back
// "this Model can't actually be built in 2C". Enforce here so the API is
// the source of truth, matching the "server-side pricing recompute"
// non-negotiable in 2990s-readonly/CLAUDE.md.
//
// Rule: empty / null `allowed_options.<key>` = NO restriction (pre-PR #50
// rows simply never set the pool — must keep working). A non-empty array
// means "only these values are accepted on a line item under this Model".
// Variants the line didn't send are ignored (only what the line sends is
// validated — the UI may legitimately omit divanHeight on a sofa SO line).
//
// Pure projection of (allowed_options × product × line.variants) → ok | err.
// No DB calls — caller pre-loads the model row via `loadModelForCode` so
// tests can hit this without Supabase. ----------------------------------------

import { normalizeCompartmentCode } from '../shared/sofa-build';

export type AllowedOptionsLite = {
  sizes?:                 string[] | null;
  compartments?:          string[] | null;
  divan_heights?:         string[] | null;
  total_heights?:         string[] | null;
  /** BEDFRAME — gap (mattress-gap) inches pool. No price contribution, but
   *  per-Model on/off-able like divan/leg (ticked in the Modular drawer). */
  gaps?:                  string[] | null;
  leg_heights?:           string[] | null;
  specials?:              string[] | null;
  /** SOFA + BEDFRAME — enabled fabric COLOUR codes (fabric_colours.colour_id,
   *  e.g. 'CG-002'). The single ON/OFF authority for which fabrics a Model
   *  offers (Chairman 2026-06-01 "一切 on/off 以 Modular 为准"). */
  fabrics?:               string[] | null;
};

/** Subset of mfg_products columns needed to validate. `model_id = null`
 *  means the SKU isn't bound to a Model (legacy row, orphan, accessory) —
 *  validation is skipped entirely in that case. */
export type ProductForCheck = {
  code:        string;
  category:    string;             // 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE'
  model_id:    string | null;
  size_code:   string | null;
};

/** Subset of product_models columns we read. */
export type ModelForCheck = {
  id:              string;
  allowed_options: AllowedOptionsLite | null;
};

/** The variant blob shape we accept on the wire. Matches MfgItemVariants
 *  in apps/api/src/lib/mfg-pricing-recompute.ts. */
export type VariantsLite = {
  divanHeight?:   string | null;
  legHeight?:     string | null;
  totalHeight?:   string | null;
  gap?:           string | null;
  seatHeight?:    string | null;
  sofaLegHeight?: string | null;
  /** SOFA multi-module build layout. When present the line's `itemCode` is only
   *  the catalog ANCHOR SKU (e.g. TELLUC-1S) — the real built modules live here
   *  and the server later splits them into per-module SO lines. The compartment
   *  gate validates THESE, not the anchor's own suffix. Each entry is a cell
   *  carrying a `moduleId` (`'2A(LHF)'`); other geometry keys (x/y/rot) ignored. */
  cells?:         Array<{ moduleId?: string | null } | unknown> | null;
  specials?:      string[] | string | null;
  special?:       string[] | string | null;
  /** The chosen fabric colour code — fabricCode is the canonical field; colourId
   *  carries the same code from the POS picker. Validated against opts.fabrics. */
  fabricCode?:    string | null;
  colourId?:      string | null;
} | null | undefined;

export type AllowedCheckError = {
  error:   'variant_not_allowed';
  field:   string;
  value:   string;
  allowed: string[];
};

const hasRestriction = (pool: string[] | null | undefined): pool is string[] => {
  return Array.isArray(pool) && pool.length > 0;
};

const toSpecialsArray = (s: string[] | string | null | undefined): string[] => {
  if (!s) return [];
  if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
  return [String(s).trim()].filter(Boolean);
};

/** Run the per-Model allowed-options check against one line item. Returns
 *  the first violation found, or null when every variant the line sent is
 *  inside the Model's pool (or the pool is empty / not restricted).
 *
 *  Caller wiring (POST + PATCH SO items):
 *    const err = checkAllowedOptions(product, model, variants);
 *    if (err) return c.json(err, 400);
 *
 *  Skipped (returns null) when:
 *    - product.model_id is null (no Model linkage — nothing to check)
 *    - model is null (FK dangling — best-effort, don't 500 the SO)
 *    - allowed_options is null / {} entirely
 *    - the specific key in allowed_options is null / [] (no restriction)
 *    - the line didn't send the corresponding variant at all
 */
export function checkAllowedOptions(
  product:  ProductForCheck | null,
  model:    ModelForCheck   | null,
  variants: VariantsLite,
): AllowedCheckError | null {
  if (!product || !product.model_id) return null;
  if (!model) return null;
  const opts = model.allowed_options ?? {};

  // ── Product-level checks (SKU's own size_code / compartment) ─────────
  // BEDFRAME + MATTRESS — size_code lives on mfg_products.
  if (
    (product.category === 'BEDFRAME' || product.category === 'MATTRESS')
    && product.size_code
    && hasRestriction(opts.sizes)
    && !opts.sizes.includes(product.size_code)
  ) {
    return {
      error: 'variant_not_allowed',
      field: 'size_code',
      value: product.size_code,
      allowed: opts.sizes,
    };
  }

  // SOFA — compartment validation.
  //
  // A POS sofa is sent as ONE line whose `itemCode` is only the catalog ANCHOR
  // SKU (the Model's representative product, e.g. TELLUC-1S) — the ACTUAL build
  // lives in `variants.cells[]`, which the server later splits into per-module
  // SO lines ({MODEL}-{moduleId}). So when cells are present we must validate
  // THOSE module codes against the pool, NOT the anchor's own suffix: the anchor
  // can be a compartment the Model doesn't offer standalone (Telluc's anchor is
  // 1S, but Telluc only allows 2A/L), which wrongly blocked EVERY Telluc 2A+L
  // build with `compartment "1S"` even though the customer never picked 1S
  // (Loo, 2026-06-08). Cells absent (legacy / hand-keyed single-SKU line) →
  // fall back to the anchor suffix check (commander's sofaCodeFormat
  // '{model_code}-{compartment}'; empty / no-dash codes are skipped).
  if (product.category === 'SOFA' && hasRestriction(opts.compartments)) {
    const cells = Array.isArray((variants ?? {})?.cells) ? (variants ?? {})!.cells! : null;
    if (cells && cells.length > 0) {
      for (const raw of cells) {
        const moduleId = raw && typeof raw === 'object'
          ? String((raw as Record<string, unknown>).moduleId ?? '').trim()
          : '';
        if (!moduleId) continue;
        const code = normalizeCompartmentCode(moduleId);
        if (code && !opts.compartments.includes(code)) {
          return {
            error: 'variant_not_allowed',
            field: 'compartment',
            value: code,
            allowed: opts.compartments,
          };
        }
      }
    } else {
      const dashAt = product.code.indexOf('-');
      const compartment = dashAt > 0 ? product.code.slice(dashAt + 1).trim() : '';
      if (compartment && !opts.compartments.includes(compartment)) {
        return {
          error: 'variant_not_allowed',
          field: 'compartment',
          value: compartment,
          allowed: opts.compartments,
        };
      }
    }
  }

  // ── Variant-level checks (live on the SO line's variants blob) ───────
  const v = variants ?? {};

  if (v.divanHeight && hasRestriction(opts.divan_heights)
      && !opts.divan_heights.includes(v.divanHeight)) {
    return {
      error: 'variant_not_allowed',
      field: 'divan_height',
      value: v.divanHeight,
      allowed: opts.divan_heights,
    };
  }

  if (v.totalHeight && hasRestriction(opts.total_heights)
      && !opts.total_heights.includes(v.totalHeight)) {
    return {
      error: 'variant_not_allowed',
      field: 'total_height',
      value: v.totalHeight,
      allowed: opts.total_heights,
    };
  }

  // gap (BEDFRAME) — no price contribution, but on/off-able per Model.
  if (v.gap && hasRestriction(opts.gaps)
      && !opts.gaps.includes(v.gap)) {
    return {
      error: 'variant_not_allowed',
      field: 'gap',
      value: v.gap,
      allowed: opts.gaps,
    };
  }

  // legHeight (bedframe) AND sofaLegHeight (sofa) both validate against
  // the same leg_heights pool — commander has only one leg-height list per
  // Model regardless of category.
  const legPick = v.legHeight ?? v.sofaLegHeight ?? null;
  if (legPick && hasRestriction(opts.leg_heights)
      && !opts.leg_heights.includes(legPick)) {
    return {
      error: 'variant_not_allowed',
      field: 'leg_height',
      value: legPick,
      allowed: opts.leg_heights,
    };
  }

  // Sofa: seatHeight maps to allowed_options.sizes (sofa "size" = seat
  // height in commander's parlance — same chip list).
  if (product.category === 'SOFA' && v.seatHeight && hasRestriction(opts.sizes)
      && !opts.sizes.includes(v.seatHeight)) {
    return {
      error: 'variant_not_allowed',
      field: 'seat_size',
      value: v.seatHeight,
      allowed: opts.sizes,
    };
  }

  // Specials — multi-pick. Reject on the first unmatched pick. Compare
  // trim-normalised on BOTH sides: `toSpecialsArray` already trims each pick,
  // but a Model's pool value (and the special_addons.code it mirrors) can carry
  // a trailing space from data entry (e.g. "Hydraulic "). Trimming only the
  // pick made the picker send a value that round-trips fine in the UI but 400s
  // here as variant_not_allowed.
  if (hasRestriction(opts.specials)) {
    const allowedTrimmed = new Set(opts.specials.map((s) => String(s).trim()));
    const picks = toSpecialsArray(v.specials ?? v.special);
    for (const p of picks) {
      if (!allowedTrimmed.has(p)) {
        return {
          error: 'variant_not_allowed',
          field: 'specials',
          value: p,
          allowed: opts.specials,
        };
      }
    }
  }

  // Fabric (SOFA + BEDFRAME) — the chosen colour code must be enabled on this
  // Model. opts.fabrics holds fabric_colours.colour_id values; the line carries
  // it as fabricCode (canonical) or colourId (POS picker). Empty pool = no gate.
  const fabricPick = v.fabricCode ?? v.colourId ?? null;
  if (fabricPick && hasRestriction(opts.fabrics) && !opts.fabrics.includes(fabricPick)) {
    return {
      error: 'variant_not_allowed',
      field: 'fabric',
      value: fabricPick,
      allowed: opts.fabrics,
    };
  }

  return null;
}

/** Loader paired with the check above. Reads the product → model rows
 *  from Supabase using the line's item_code. Returns nulls when either
 *  side is missing (caller's check shortcircuits to "allowed"). Safe to
 *  call with empty / missing item_code (returns nulls).
 *
 *  Keeping the I/O here lets the SO route hand a clean (product, model)
 *  tuple into checkAllowedOptions without the test having to mock two
 *  table builds. */
/*  `code` is NOT unique — both companies keep their own SKU master and 17 codes
 *  collided on production 2026-08-01. Unscoped, the `.maybeSingle()` below
 *  ERRORS on a duplicated code (PGRST116) and the discarded error becomes
 *  `product = null`, which this gate reads as "allowed" — it stops checking
 *  rather than stops the line. Callers pass `activeCompanyId(c)`;
 *  null/undefined degrades to no predicate, as everywhere else. */
export async function loadProductAndModel(
  sb:        any,
  itemCode:  string | null | undefined,
  companyId?: number | null,
): Promise<{ product: ProductForCheck | null; model: ModelForCheck | null }> {
  const code = (itemCode ?? '').trim();
  if (!code) return { product: null, model: null };

  let pq = sb
    .from('mfg_products')
    .select('code, category, model_id, size_code')
    .eq('code', code);
  if (companyId != null) pq = pq.eq('company_id', companyId);
  const { data: productRow } = await pq.maybeSingle();
  const product = (productRow ?? null) as ProductForCheck | null;
  if (!product || !product.model_id) return { product, model: null };

  const { data: modelRow } = await sb
    .from('product_models')
    .select('id, allowed_options')
    .eq('id', product.model_id)
    .maybeSingle();
  const model = (modelRow ?? null) as ModelForCheck | null;
  return { product, model };
}

/** Batched mirror of {@link loadProductAndModel} — TWO `in()` queries for a
 *  whole order (products by code, then their models), keyed by item code.
 *  Subrequest diet (Loo 2026-06-06): the per-line loader cost 2 subrequests ×
 *  lines on the SO create path and helped a 6-item order blow the CF Workers
 *  per-request cap. Missing codes simply have no entry (caller treats as
 *  nulls → "allowed"). */
export async function loadProductsAndModels(
  sb:        any,
  itemCodes: Array<string | null | undefined>,
  companyId?: number | null,
): Promise<Map<string, { product: ProductForCheck | null; model: ModelForCheck | null }>> {
  const out = new Map<string, { product: ProductForCheck | null; model: ModelForCheck | null }>();
  const codes = Array.from(new Set(itemCodes.map((c) => (c ?? '').trim()).filter(Boolean)));
  if (codes.length === 0) return out;

  let pq = sb
    .from('mfg_products')
    .select('code, category, model_id, size_code')
    .in('code', codes);
  if (companyId != null) pq = pq.eq('company_id', companyId);
  const { data: productRows } = await pq;
  const products = ((productRows as ProductForCheck[]) ?? []);

  const modelIds = Array.from(new Set(products.map((p) => p.model_id).filter(Boolean))) as string[];
  const modelById = new Map<string, ModelForCheck>();
  if (modelIds.length > 0) {
    const { data: modelRows } = await sb
      .from('product_models')
      .select('id, allowed_options')
      .in('id', modelIds);
    for (const m of ((modelRows as ModelForCheck[]) ?? [])) modelById.set(m.id, m);
  }

  for (const p of products) {
    out.set(p.code, { product: p, model: p.model_id ? (modelById.get(p.model_id) ?? null) : null });
  }
  return out;
}
