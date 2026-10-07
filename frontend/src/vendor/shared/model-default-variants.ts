// ----------------------------------------------------------------------------
// model-default-variants — the variant a new line starts with when a Model's
// SKU is picked (Weisiang 2026-10-07).
//
// Two readers: the Model PATCH route (refuses a default outside the Model's
// allowed options) and the line pickers (SoLineCard, MobileNewSO) that pre-fill
// it. The browser copy is frontend/src/vendor/shared/model-default-variants.ts,
// held byte-identical by model-default-variants.canonical.test.ts.
//
// Defaults are keyed like a line's variants. Only single-value axes a person
// picks from the Model's own pool can default; fabric (a set of identity keys),
// specials (multi-pick, priced) and computed / SKU-level axes cannot.
// PRECEDENCE: a SKU's own default_variants beats the Model's for the same key.
// ----------------------------------------------------------------------------

import { normaliseTypographicQuotes } from './mfg-pricing';

/** category -> line variant key -> the allowed_options pool it must come from. */
export const MODEL_DEFAULT_AXES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  SOFA:     { seatHeight: 'sizes', legHeight: 'leg_heights' },
  BEDFRAME: { divanHeight: 'divan_heights', gap: 'gaps', legHeight: 'leg_heights' },
};

const axesFor = (category: string) => MODEL_DEFAULT_AXES[category.toUpperCase()] ?? {};
const fold = (s: string) => normaliseTypographicQuotes(s).trim();
/* Empty / absent pool = no restriction, the same reading the save gate uses. */
const inPool = (pool: unknown, value: string) =>
  !Array.isArray(pool) || pool.length === 0 || pool.some((p) => fold(String(p)) === fold(value));
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const keyOf = (o: unknown, k: string) =>
  o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;

/** The first default key that is not allowed on this Model, or null when all are. */
export function invalidModelDefault(
  category: string,
  defaults: Record<string, string>,
  allowedOptions: unknown,
): string | null {
  const axes = axesFor(category);
  for (const [key, value] of Object.entries(defaults)) {
    const poolKey = axes[key];
    if (!poolKey || !inPool(keyOf(allowedOptions, poolKey), value)) return key;
  }
  return null;
}

/** What a freshly picked line's variants start from: per axis the SKU default,
 *  else the Model default, skipping any value the Model no longer allows. */
export function pickDefaultVariants(
  category: string,
  modelDefaults: unknown,
  skuDefaults: unknown,
  allowedOptions: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, poolKey] of Object.entries(axesFor(category))) {
    const pool = keyOf(allowedOptions, poolKey);
    const value = [keyOf(skuDefaults, key), keyOf(modelDefaults, key)]
      .map(str)
      .find((v): v is string => v !== null && inPool(pool, v));
    if (value) out[key] = value;
  }
  return out;
}
