// ----------------------------------------------------------------------------
// Maintenance option-pool ACTIVE semantics (owner spec 2026-06-12).
//
// Every Products → Maintenance pool entry can now carry `active?: boolean`:
//   • string pools (gaps, sofaSizes, bedframeSizes, mattressSizes,
//     sofaCompartments, brandings, supplierCategories) — entries are either a
//     plain string (= active, the historic shape, byte-identical for existing
//     rows) or `{ value, active?: boolean }` (the editor only writes the
//     object form when a row is toggled INACTIVE; re-activating collapses it
//     back to the plain string so untouched configs never change shape).
//   • priced pools (divanHeights, totalHeights, legHeights, sofaLegHeights,
//     specials, sofaSpecials) — the existing { value, priceSen, ... } object
//     gains an optional `active` flag.
//
// Semantics: an INACTIVE option is NOT selectable in any picker for NEW
// entries, but documents / SKUs that already carry the value keep displaying
// it. Cost/price lookups therefore NEVER filter on active — only pickers do.
//
//   maintValues()       → every value (display, cost lookups, exports, edits)
//   maintActiveValues() → picker pools for new selections
//   activeOptions()     → same for priced pools (optionally keeping a doc's
//                         current value so an edit form still shows it)
// ----------------------------------------------------------------------------

import { normaliseTypographicQuotes } from './mfg-pricing';

export type MaintPoolEntry = string | { value: string; active?: boolean };

/** Unwrap one entry to its value string. */
export const maintEntryValue = (e: MaintPoolEntry): string =>
  typeof e === 'string' ? e : e.value;

/** Plain strings are active; objects are active unless `active === false`. */
export const maintEntryActive = (e: MaintPoolEntry): boolean =>
  typeof e === 'string' ? true : e.active !== false;

/** ALL values — use for display enrichment, cost/price lookups, exports,
 *  rename-cascade detection. NEVER filters on active. */
export const maintValues = (
  list: readonly MaintPoolEntry[] | null | undefined,
): string[] => (list ?? []).map(maintEntryValue);

/** ACTIVE values only — use to build pickers for NEW selections. */
export const maintActiveValues = (
  list: readonly MaintPoolEntry[] | null | undefined,
): string[] => (list ?? []).filter(maintEntryActive).map(maintEntryValue);

/** Priced-pool picker filter. Drops inactive options but keeps `keepValue`
 *  (the doc's currently-saved value) so edit forms still render it. */
export const activeOptions = <T extends { value: string; active?: boolean }>(
  list: readonly T[] | null | undefined,
  keepValue?: string | null,
): T[] =>
  (list ?? []).filter(
    (o) => o.active !== false || (keepValue != null && keepValue !== '' && o.value === keepValue),
  );

/** String-pool picker values. Active values plus, when provided, the doc's
 *  current (possibly inactive) value so the select doesn't blank out. */
export const maintPickerValues = (
  list: readonly MaintPoolEntry[] | null | undefined,
  current?: string | null,
): string[] => {
  const vals = maintActiveValues(list);
  if (current && !vals.includes(current) && maintValues(list).includes(current)) {
    vals.push(current);
  }
  return vals;
};

/** Per-Model allowed_options restriction (owner 2026-07-15 "options must follow
 *  the maintenance config, not a backdoor"). Both take an already-active option
 *  list (global maintenance pool, inactive rows already dropped) and intersect
 *  it with the SKU's Model `allowed_options` pool for that axis:
 *    • pool EMPTY / absent  → no restriction (offer every active option) — the
 *      same opt-out semantics the server allowed-options gate uses.
 *    • pool NON-EMPTY       → keep only the values the Model permits.
 *  These are the SINGLE source for the restrict step every variant editor
 *  (SoLineCard, MobileNewSO, PoLineCard, PcVariantEditor) shares — no editor
 *  may inline its own copy again.
 *  The RULE both platforms must keep: a saved value the Model no longer permits
 *  stays VISIBLE on an edit form (never silently dropped) while new picks are
 *  pool-only. WHERE that grandfather runs differs by surface, and both are
 *  correct: desktop passes the line's current value as `keep` here, because a
 *  raw <select> can only render what its <option> list holds; mobile's SpecSel
 *  re-adds an off-pool stored value as "<value> (current)" at the render layer
 *  and so calls these without `keep`. Check the caller's render before assuming
 *  a missing `keep` is a bug. */
/* THE COMPARISON FOLDS TYPOGRAPHIC QUOTES, because the two sides of it are
   spelled by different hands. A maintenance pool is TYPED BY A PERSON into the
   Modular drawer, and Windows / Word / a phone keyboard turn an inch mark into
   U+201C or U+201D; the editors emit U+0022 (`${d + l + g}"`,
   SoLineCard.tsx). A raw `includes` therefore drops an option the Model plainly
   lists.

   MEASURED on production 2026-09-11: of company 1's pools, `gaps` holds TEN
   curly-spelled values (11” 12“ 13” 14“ 15” 16“ 17” 18“ 19” 20“) and
   `total_heights` SIX (17“ 19“ 21” 23“ 25” 27“), across 10 bedframe Models. So
   Gap 11 through 20 inch were invisible in the picker on BOTH surfaces while
   the SERVER would have accepted every one of them - `inPool` in
   allowed-options-check.ts has folded since 2026-08-17.

   That asymmetry was known and left: SoLineCard carried the comment "these two
   filters deliberately still do not [fold], because widening them CHANGES
   WHICH OPTIONS APPEAR - an owner's call, not a bug fix". The owner's call came
   on 2026-09-11: 「不止 fabric，divan gap 等等也是」. docs/bugs/0814.

   Folding only normalises the GLYPH, never the number or the word, so no pool
   gains a value it does not list. */
const foldPool = (pool: readonly string[]) => new Set(pool.map((v) => normaliseTypographicQuotes(String(v)).trim()));
const inFolded = (folded: Set<string>, value: string) =>
  folded.has(normaliseTypographicQuotes(String(value)).trim());

export const restrictPricedToPool = <T extends { value: string }>(
  opts: readonly T[],
  pool?: readonly string[] | null,
  keep?: string | null,
): T[] => {
  if (!Array.isArray(pool) || pool.length === 0) return [...opts];
  const folded = foldPool(pool);
  return opts.filter((o) => inFolded(folded, o.value) || (!!keep && o.value === keep));
};

export const restrictStringsToPool = (
  opts: readonly string[],
  pool?: readonly string[] | null,
  keep?: string | null,
): string[] => {
  if (!Array.isArray(pool) || pool.length === 0) return [...opts];
  const folded = foldPool(pool);
  return opts.filter((o) => inFolded(folded, o) || (!!keep && o === keep));
};

/** Editor helper — rewrite an entry's value, preserving its active flag. */
export const maintEntryWithValue = (e: MaintPoolEntry, value: string): MaintPoolEntry =>
  typeof e === 'string' ? value : { ...e, value };

/** Editor helper — set the active flag. Re-activating collapses the entry
 *  back to the plain-string shape so untouched configs stay byte-identical. */
export const maintEntryWithActive = (e: MaintPoolEntry, active: boolean): MaintPoolEntry => {
  const value = maintEntryValue(e);
  return active ? value : { value, active: false };
};

/** "Default all-on, untick-to-exclude" seed for a per-Model allowed_options
 *  editor (PR #87 mental model, mirrors the Backend ProductModelDetail
 *  `fillIfEmpty`). For each (key → master pool) in `fills`, if the saved
 *  allowed_options[key] is EMPTY or ABSENT and the pool is non-empty, seed it
 *  with the full pool so the chip editor renders every option ON.
 *
 *  Why this is needed: an empty allowed_options[key] reads as "no restriction =
 *  offer EVERY option" downstream (e.g. `useSofaLegHeights`, the server gate).
 *  A chip editor that renders that empty list as "nothing ticked" is then a
 *  trap — unticking an already-empty list is a no-op, so a user can never
 *  deactivate a single option (the leg-height report, 2026-06-16).
 *
 *  Only pass pools whose empty-means-ALL semantics hold AND that are
 *  side-effect-free on save. leg_heights qualifies. Opt-in pools (specials,
 *  fabrics — empty = NONE in the POS configurator) and pools with PATCH side
 *  effects (sizes mirror pos_active; compartments auto-create SKUs) must NOT be
 *  passed in. Pure: never mutates `saved`; returns a shallow copy. */
export function fillEmptyAllowedOptions<T extends Record<string, unknown>>(
  saved: T,
  fills: Record<string, readonly string[]>,
): T {
  const next: Record<string, unknown> = { ...saved };
  for (const [key, pool] of Object.entries(fills)) {
    const cur = next[key];
    if (pool.length > 0 && (!Array.isArray(cur) || cur.length === 0)) {
      next[key] = [...pool];
    }
  }
  return next as T;
}
