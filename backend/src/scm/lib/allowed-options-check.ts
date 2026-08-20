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
import { normaliseTypographicQuotes } from '../shared/mfg-pricing';

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

/** One input BEHIND a refused field that the operator can actually edit.
 *  Only present when `field` is COMPUTED — see `derivedFrom` below. */
export type AllowedCheckErrorPart = { field: string; value: string };

export type AllowedCheckError = {
  error:   'variant_not_allowed';
  field:   string;
  value:   string;
  allowed: string[];
  /** ADDITIVE (2026-08-18), and the reason the bedframe message can be written
   *  at all. `total_height` is not something the salesperson types — it is
   *  divan + leg + gap, computed by the editor (SoLineCard.tsx:430-437) and
   *  written into the draft; the form has NO Total Height input. So a refusal
   *  that names only `total_height` names a field he cannot reach, and the
   *  client cannot invent the decomposition because the body never carried it.
   *
   *  Present ONLY on a computed field, and always with EVERY input behind it
   *  (value `''` when the line didn't send that one), so the client can name
   *  all three boxes even when only one is filled. Absent on every field the
   *  operator types directly — its absence is what tells the client "this one
   *  IS the box to change". No existing key changes meaning. */
  derivedFrom?: AllowedCheckErrorPart[];
};

const hasRestriction = (pool: string[] | null | undefined): pool is string[] => {
  return Array.isArray(pool) && pool.length > 0;
};

/* ─── Pool membership ─────────────────────────────────────────────────────
   EXACT FIRST, THEN QUOTE-INSENSITIVE, and that ordering is the whole safety
   argument — it is the same one `findOption` in mfg-pricing.ts:198-205 makes,
   reusing that module's single `normaliseTypographicQuotes` definition rather
   than growing a second one.

   THE MEASUREMENT (prod, 2026-08-17, probe run 32048732641). All 10 BEDFRAME
   Models that restrict `total_heights` share ONE 16-value pool, and it is
   glyph-inconsistent: the even values 10..28 carry an ASCII inch mark (U+0022)
   while 17/19/23/27 carry U+201C and 21/25 carry U+201D. The `gaps` pool on the
   same Models splits the same way — 7 ASCII, 10 curly. The editor can only ever
   emit ASCII (SoLineCard.tsx:436 is a template literal ending `"`), and this
   gate compared with a raw `Array.includes`, i.e. `===` on strings. So EVERY
   ODD TOTAL was refused by a pool that visibly lists that number. Counting only
   the gaps the picker can actually offer, 94 of 280 divan x leg x gap
   combinations refused ON THE QUOTE CHARACTER ALONE — a permanent 400 on a
   line the operator had no way to correct, and a message that would have read
   `17" is not allowed. Allowed: …, 17“, …`.

   `17"` and `17“` are the same physical height. Refusing one is a typing
   accident in a maintenance row, not a business rule, so folding them is not a
   weakening: an exact hit is still preferred, so nothing that matches today can
   change meaning, and only a value that matches NOTHING today — and therefore
   already 400s — can start matching. WHICH values a Model permits is untouched.

   Deliberately narrow, exactly as the pricing engine chose: quote characters
   only. No trim, no case folding — those are separate behaviour changes, and
   this same string family also composes `variant_key`, the inventory bucket
   identity. */
const inPool = (pool: string[], value: string): boolean => {
  if (pool.includes(value)) return true;
  const wanted = normaliseTypographicQuotes(value);
  return pool.some((p) => normaliseTypographicQuotes(p) === wanted);
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
    && !inPool(opts.sizes, product.size_code)
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
        if (code && !inPool(opts.compartments, code)) {
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
      if (compartment && !inPool(opts.compartments, compartment)) {
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
      && !inPool(opts.divan_heights, v.divanHeight)) {
    return {
      error: 'variant_not_allowed',
      field: 'divan_height',
      value: v.divanHeight,
      allowed: opts.divan_heights,
    };
  }

  /* total_height is COMPUTED, never typed — divan + leg + gap, written into the
     draft by SoLineCard.tsx:439-445, with no Total Height input on the form. So
     this is the one refusal that must hand the client the inputs behind it;
     without `derivedFrom` the only honest message names a box that does not
     exist. Every part is listed even when empty, so the message can name all
     three boxes while showing values only for the ones that are filled. */
  if (v.totalHeight && hasRestriction(opts.total_heights)
      && !inPool(opts.total_heights, v.totalHeight)) {
    return {
      error: 'variant_not_allowed',
      field: 'total_height',
      value: v.totalHeight,
      allowed: opts.total_heights,
      derivedFrom: [
        { field: 'divan_height', value: v.divanHeight ?? '' },
        { field: 'leg_height',   value: v.legHeight ?? v.sofaLegHeight ?? '' },
        { field: 'gap',          value: v.gap ?? '' },
      ],
    };
  }

  // gap (BEDFRAME) — no price contribution, but on/off-able per Model.
  if (v.gap && hasRestriction(opts.gaps)
      && !inPool(opts.gaps, v.gap)) {
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
      && !inPool(opts.leg_heights, legPick)) {
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
      && !inPool(opts.sizes, v.seatHeight)) {
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
    const allowedTrimmed = opts.specials.map((s) => String(s).trim());
    const picks = toSpecialsArray(v.specials ?? v.special);
    for (const p of picks) {
      if (!inPool(allowedTrimmed, p)) {
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
  if (fabricPick && hasRestriction(opts.fabrics) && !inPool(opts.fabrics, fabricPick)) {
    return {
      error: 'variant_not_allowed',
      field: 'fabric',
      value: fabricPick,
      allowed: opts.fabrics,
    };
  }

  return null;
}

/** The (product, model) pair the pure check consumes. */
export type ProductAndModelPair = { product: ProductForCheck | null; model: ModelForCheck | null };

/** …plus the reason the catalog could not be read. `lookupError !== null` means
 *  NO VERDICT WAS REACHED — the nulls beside it are ignorance, not permission. */
export type ProductAndModel = ProductAndModelPair & { lookupError: string | null };

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
 *  ERRORS on a duplicated code (PGRST116). That error is now RETURNED as
 *  `lookupError` (2026-08-13 swallowed-error sweep); it used to be discarded,
 *  and the resulting `product = null` read to this gate as "allowed" — it
 *  stopped checking rather than stopping the line, so the exact case the
 *  company scope was added to fix wrote a line with an unvalidated variant. A
 *  failed read must never read as an absence when the absence is what
 *  authorises the write: callers refuse on `lookupError` instead of proceeding.
 *  Callers pass `activeCompanyId(c)`; null/undefined degrades to no predicate,
 *  as everywhere else. */
export async function loadProductAndModel(
  sb:        any,
  itemCode:  string | null | undefined,
  companyId: number | null | undefined,
): Promise<ProductAndModel> {
  const code = (itemCode ?? '').trim();
  if (!code) return { product: null, model: null, lookupError: null };

  let pq = sb
    .from('mfg_products')
    .select('code, category, model_id, size_code')
    .eq('code', code);
  if (companyId != null) pq = pq.eq('company_id', companyId);
  const { data: productRow, error: pErr } = await pq.maybeSingle();
  if (pErr) return { product: null, model: null, lookupError: `mfg_products: ${pErr.message}` };
  const product = (productRow ?? null) as ProductForCheck | null;
  if (!product || !product.model_id) return { product, model: null, lookupError: null };

  const { data: modelRow, error: mErr } = await sb
    .from('product_models')
    .select('id, allowed_options')
    .eq('id', product.model_id)
    .maybeSingle();
  if (mErr) return { product, model: null, lookupError: `product_models: ${mErr.message}` };
  const model = (modelRow ?? null) as ModelForCheck | null;
  return { product, model, lookupError: null };
}

/** Batched mirror of {@link loadProductAndModel} — TWO `in()` queries for a
 *  whole order (products by code, then their models), keyed by item code.
 *  Subrequest diet (Loo 2026-06-06): the per-line loader cost 2 subrequests ×
 *  lines on the SO create path and helped a 6-item order blow the CF Workers
 *  per-request cap. Missing codes simply have no entry (caller treats as
 *  nulls → "allowed") — which is why `lookupError` is carried out alongside the
 *  map: an entry missing because the READ FAILED must not be spent as that same
 *  "allowed". Callers refuse on a non-null `lookupError`. */
export async function loadProductsAndModels(
  sb:        any,
  itemCodes: Array<string | null | undefined>,
  companyId: number | null | undefined,
): Promise<{ byCode: Map<string, ProductAndModelPair>; lookupError: string | null }> {
  const out = new Map<string, ProductAndModelPair>();
  const codes = Array.from(new Set(itemCodes.map((c) => (c ?? '').trim()).filter(Boolean)));
  if (codes.length === 0) return { byCode: out, lookupError: null };

  let pq = sb
    .from('mfg_products')
    .select('code, category, model_id, size_code')
    .in('code', codes);
  if (companyId != null) pq = pq.eq('company_id', companyId);
  const { data: productRows, error: pErr } = await pq;
  if (pErr) return { byCode: out, lookupError: `mfg_products: ${pErr.message}` };
  const products = ((productRows as ProductForCheck[]) ?? []);

  const modelIds = Array.from(new Set(products.map((p) => p.model_id).filter(Boolean))) as string[];
  const modelById = new Map<string, ModelForCheck>();
  if (modelIds.length > 0) {
    const { data: modelRows, error: mErr } = await sb
      .from('product_models')
      .select('id, allowed_options')
      .in('id', modelIds);
    if (mErr) return { byCode: out, lookupError: `product_models: ${mErr.message}` };
    for (const m of ((modelRows as ModelForCheck[]) ?? [])) modelById.set(m.id, m);
  }

  for (const p of products) {
    out.set(p.code, { product: p, model: p.model_id ? (modelById.get(p.model_id) ?? null) : null });
  }
  return { byCode: out, lookupError: null };
}

/** Canonical refusal for "the catalog could not be read, so no variant verdict
 *  was reached". A 409 the operator can retry, never a silent pass. */
export const variantCheckUnavailableResponse = (reason: string) => ({
  error: 'variant_check_failed',
  message: `Could not check this line's allowed options, so it was not saved — try again (${reason}).`,
});
