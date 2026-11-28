
import { normalizeCompartmentCode } from '../shared/sofa-build';
import { normaliseTypographicQuotes } from '../shared/mfg-pricing';
import { fabricAllowedByPool } from '../shared/fabric-pool';
import { isDivanOnly } from '../shared/so-variant-rule';
import { pgrestIn } from './pgrest-in-list';

export type AllowedOptionsLite = {
  sizes?:                 string[] | null;
  compartments?:          string[] | null;
  divan_heights?:         string[] | null;
  total_heights?:         string[] | null;
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
  category:    string;
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
  cells?:         Array<{ moduleId?: string | null } | unknown> | null;
  specials?:      string[] | string | null;
  special?:       string[] | string | null;
  fabricCode?:    string | null;
  colourId?:      string | null;
  fabricId?:      string | null;
} | null | undefined;

/** One input BEHIND a refused field that the operator can actually edit.
 *  Only present when `field` is COMPUTED — see `derivedFrom` below. */
export type AllowedCheckErrorPart = { field: string; value: string };

export type AllowedCheckError = {
  error:   'variant_not_allowed';
  field:   string;
  value:   string;
  allowed: string[];
  derivedFrom?: AllowedCheckErrorPart[];
};

const hasRestriction = (pool: string[] | null | undefined): pool is string[] => {
  return Array.isArray(pool) && pool.length > 0;
};

/* Folds the GLYPH and TRIMS, because both sides of this comparison are typed by
   different hands: a pool is typed by a person into the Modular drawer (Windows
   turns an inch mark into U+201C/U+201D, and a stray space survives a paste),
   while the line's value is emitted by the editor.

   TRIMMING IS NOT COSMETIC HERE. Measured on production 2026-09-11: all 79 of
   company 1's sofa Models carry the fabric `"TARONI "` — with a trailing space.
   The pickers trim (vendor/shared/maintenance-pools.ts), so without this the
   two sides disagree on TARONI alone: the screen offers it and the save refuses
   it, which is the exact shape of the defect this whole change is about.
   docs/bugs/0814. */
const foldForPool = (s: string): string => normaliseTypographicQuotes(s).trim();
const inPool = (pool: string[], value: string): boolean => {
  if (pool.includes(value)) return true;
  const wanted = foldForPool(value);
  return pool.some((p) => foldForPool(p) === wanted);
};

export const isTotalHeightAllowed = (
  totalHeights: string[] | null | undefined,
  productCode: string,
  value: string,
): boolean => !hasRestriction(totalHeights) || isDivanOnly(productCode) || inPool(totalHeights, value);

const isZeroLeg = (s: string): boolean => {
  const f = foldForPool(s).toLowerCase().replace(/\s+/g, '');
  return f === 'noleg' || /^0(?:\.0+)?"?$/.test(f);
};
const legInPool = (pool: string[], value: string): boolean =>
  inPool(pool, value) || (isZeroLeg(value) && pool.some(isZeroLeg)) || /^\s*default\s*$/i.test(value);

const compartmentInPool = (pool: string[], value: string): boolean =>
  inPool(pool, value)
  || pool.some((p) => foldForPool(p).toUpperCase() === foldForPool(value).toUpperCase());

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

  if (product.category === 'SOFA' && hasRestriction(opts.compartments)) {
    const cells = Array.isArray((variants ?? {})?.cells) ? (variants ?? {})!.cells! : null;
    if (cells && cells.length > 0) {
      for (const raw of cells) {
        const moduleId = raw && typeof raw === 'object'
          ? String((raw as Record<string, unknown>).moduleId ?? '').trim()
          : '';
        if (!moduleId) continue;
        const code = normalizeCompartmentCode(moduleId);
        if (code && !compartmentInPool(opts.compartments, code)) {
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
      if (compartment && !compartmentInPool(opts.compartments, compartment)) {
        return {
          error: 'variant_not_allowed',
          field: 'compartment',
          value: compartment,
          allowed: opts.compartments,
        };
      }
    }
  }

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

  /* total_height is COMPUTED, never typed — divan + leg + gap, decided by
     `shared/total-height.ts` (mirrored to frontend/src/vendor/shared) and
     written into the draft by whichever screen is open, with no Total Height
     input on any of the forms. So this is the one refusal that must hand the
     client the inputs behind it; without `derivedFrom` the only honest message
     names a box that does not exist. Every part is listed even when empty, so
     the message can name all three boxes while showing values only for the ones
     that are filled.

     THE GUARD BELOW IS ALSO THE CONTRACT FOR AN EMPTY HEIGHT. `v.totalHeight`
     being falsy skips the gate entirely, which is what makes it safe for the
     client to write '' when divan, leg and gap are all blank: a cleared spec is
     not refused, it is simply not checked. Before the sixteen private copies of
     that rule were unified, two of them left a STALE height on a cleared line
     instead — and a stale height is exactly what this gate then refuses, naming
     a field the operator cannot edit.

     A DIVAN ONLY LINE IS NOT CHECKED HERE (owner 2026-08-09 "divan only 不需要
     gap", asked again 2026-09-15). It has no mattress, so its gap is left blank,
     and divan + leg + nothing is a height the pool was never written for: the
     one DIVAN ONLY Model on prod lists totals 10"-28", so an 8" divan with No Leg
     summed to 8" and was refused (HC-SO-011153, 2026-09-15 12:18 MYT). The only
     way past was to pick a Gap the product does not have. Its divan and leg
     picks are still held to their own pools just above and below. */
  if (v.totalHeight && !isTotalHeightAllowed(opts.total_heights, product.code, v.totalHeight)) {
    return {
      error: 'variant_not_allowed',
      field: 'total_height',
      value: v.totalHeight,
      allowed: opts.total_heights ?? [],
      derivedFrom: [
        { field: 'divan_height', value: v.divanHeight ?? '' },
        { field: 'leg_height',   value: v.legHeight ?? v.sofaLegHeight ?? '' },
        { field: 'gap',          value: v.gap ?? '' },
      ],
    };
  }

  if (v.gap && hasRestriction(opts.gaps)
      && !inPool(opts.gaps, v.gap)) {
    return {
      error: 'variant_not_allowed',
      field: 'gap',
      value: v.gap,
      allowed: opts.gaps,
    };
  }

  const legPick = v.legHeight ?? v.sofaLegHeight ?? null;
  if (legPick && hasRestriction(opts.leg_heights)
      && !legInPool(opts.leg_heights, legPick)) {
    return {
      error: 'variant_not_allowed',
      field: 'leg_height',
      value: legPick,
      allowed: opts.leg_heights,
    };
  }

  if (product.category === 'SOFA' && v.seatHeight && hasRestriction(opts.sizes)
      && !inPool(opts.sizes, v.seatHeight)) {
    return {
      error: 'variant_not_allowed',
      field: 'seat_size',
      value: v.seatHeight,
      allowed: opts.sizes,
    };
  }

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

  /* Fabric (SOFA + BEDFRAME) — the chosen fabric must be enabled on this Model.
     Empty pool = no gate.

     THE POOL IS A LIST OF SERIES, NOT COLOURS, AND BOTH ARE ACCEPTED. This
     comment used to read "opts.fabrics holds fabric_colours.colour_id values",
     and the code matched the comment — but the SCREEN THAT FILLS THE POOL offers
     SERIES: ProductModelDetail hands the drawer
     `fabricLibQ.data.filter(active).map(f => f.id)`, i.e. fabric_library ids.
     One field, two vocabularies, and the owner found it the only way anybody
     could: he opened the allow and his staff still could not pick.

     MEASURED on production 2026-09-11 (company 1): all 79 sofa Models carry the
     SAME 101-entry pool, 91 of those entries are fabric_library ids and 3 are
     colour ids, while 851 fabric colours are active. So of 851 colours exactly
     THREE could be picked, and `GD2502-11` — active, and the one he reported —
     was refused by every Model.

     Accepting both is the fix rather than rewriting the pool, because the two
     readings are not in conflict: a SERIES in the pool means "this Model offers
     this fabric", which is how the business approves a fabric (you approve the
     cloth, not each shade), and it keeps working when the supplier adds a shade.
     A COLOUR in the pool still means that one shade. docs/bugs/0814.
     The rule itself lives in shared/fabric-pool.ts, which the desktop and phone
     pickers read too, so what they offer is what this saves (docs/bugs/0889). */
  const fabricPick = v.fabricCode ?? v.colourId ?? null;
  const fabricSeries = v.fabricId ?? null;
  if (fabricPick && hasRestriction(opts.fabrics) && !fabricAllowedByPool(opts.fabrics, fabricPick, fabricSeries)) {
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

  let pq = pgrestIn(sb
    .from('mfg_products')
    .select('code, category, model_id, size_code'), 'code', codes);
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

/** One plain sentence for a `variant_not_allowed` body, for callers with no
 *  client-side humanApiError to compose it — the background scan job surfaced
 *  this refusal as a bare "could not be created" (ZNT 4821, 2026-09-30). */
export function variantNotAllowedSentence(body: Record<string, unknown>): string | null {
  if (body.error !== 'variant_not_allowed') return null;
  const item = typeof body.itemCode === 'string' && body.itemCode ? body.itemCode : 'One item';
  const field = typeof body.field === 'string' ? body.field.replace(/_/g, ' ') : 'option';
  const value = typeof body.value === 'string' ? ` "${body.value}"` : '';
  return `${item}: the ${field}${value} is not allowed for this model. Please enter this order manually.`;
}

/** Canonical refusal for "the catalog could not be read, so no variant verdict
 *  was reached". A 409 the operator can retry, never a silent pass. */
export const variantCheckUnavailableResponse = (reason: string) => ({
  error: 'variant_check_failed',
  message: `Could not check this line's allowed options, so it was not saved — try again (${reason}).`,
});

/**
 * The variants a line EDIT must answer for: every key as sent, except the
 * specials the line ALREADY held. An untouched line is grandfathered whole (the
 * PATCH skips the check); a touched line used to be re-judged whole, so a special
 * stored before the Model's pool changed spelling (38 lines hold "hydraulic"
 * against a pool offering "Hydraulic") refused ANY edit to the line — picking
 * the fabric needed to proceed included (HC-SO-011014, 2026-09-30). A special the
 * edit ADDS is still judged against today's pool.
 */
export function variantsForEditCheck(next: VariantsLite, prev: VariantsLite): VariantsLite {
  if (next == null || typeof next !== 'object') return next;
  const had = new Set(toSpecialsArray((prev as { specials?: string[] | string | null } | null)?.specials));
  if (had.size === 0) return next;
  const n = next as { specials?: string[] | string | null; special?: string[] | string | null };
  const kept = toSpecialsArray(n.specials ?? n.special).filter((p) => !had.has(p));
  const { special: _legacy, ...rest } = n;
  return { ...rest, specials: kept } as VariantsLite;
}
