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

/* ── Inch-mark hygiene on config SAVE (the quote-doubling mint, 2026-08-01) ──
 *
 * The costing audit's residual family carried variant keys with a DOUBLED inch
 * mark (`legheight=1""` vs the documents' `1"`). Tracing the mint: NO code
 * path in this repo (or the 2990 POS) appends a quote — every height editor is
 * a select fed by these option pools — so the doubling was a HAND-KEYED pool
 * value, copied verbatim into line variants and from there into ledger keys,
 * splitting one physical bucket in two. This save-side hygiene closes the
 * only in-repo door the class can walk through: option values in the
 * inch-bearing pools collapse any run of double-quote marks to one and drop
 * trailing whitespace, exactly the normalizeVariantKeyQuotes equivalence the
 * doc-relabel repair uses. Applied on WRITE only — stored history is never
 * rewritten, and computeVariantKey stays untouched (re-keying history is the
 * one thing this fix must never do). */

const INCH_POOLS = [
  'gaps',
  'legHeights',
  'sofaLegHeights',
  'divanHeights',
  'totalHeights',
  'sofaSizes',
] as const;

export const normalizeInchValue = (v: string): string =>
  v.replace(/"{2,}/g, '"').replace(/\s+$/, '');

/** Normalize the inch-bearing pools of one maintenance config object. Pure:
 *  returns the SAME reference when nothing changes (so an untouched save stays
 *  byte-identical), a shallow-copied config otherwise. Entries keep their
 *  shape (plain string stays a string; {value,...} keeps its flags). Non-pool
 *  values (notes, labels, prices) are deliberately not walked. */
export function normalizeConfigInchPools<T>(config: T): T {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) return config;
  const obj = config as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...obj };
  for (const pool of INCH_POOLS) {
    const list = obj[pool];
    if (!Array.isArray(list)) continue;
    let listChanged = false;
    const mapped = list.map((e) => {
      if (typeof e === 'string') {
        const n = normalizeInchValue(e);
        if (n !== e) listChanged = true;
        return n;
      }
      if (e && typeof e === 'object' && typeof (e as { value?: unknown }).value === 'string') {
        const val = (e as { value: string }).value;
        const n = normalizeInchValue(val);
        if (n !== val) {
          listChanged = true;
          return { ...(e as Record<string, unknown>), value: n };
        }
      }
      return e;
    });
    if (listChanged) {
      next[pool] = mapped;
      changed = true;
    }
  }
  return changed ? (next as T) : config;
}
