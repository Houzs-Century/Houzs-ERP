// ----------------------------------------------------------------------------
// sort-options — shared natural-sort comparators for SCM dropdown / <select>
// option lists.
//
// Owner directive: "anything alphabetic should auto-sort." These helpers are
// applied to the OPTIONS BEFORE RENDER (display order only — they never mutate
// stored data or change selection/save logic). Callers spread-copy first
// (`[...list].sort(cmp)`) so the source array is left untouched.
//
//   - byText      → case-insensitive alphabetical (localeCompare) for text
//                   pickers: warehouse / supplier / product / category /
//                   branding / fabric / customer / state / driver, etc.
//   - byNumeric   → numeric ascending on the leading number, so size/height/gap
//                   lists order "10\"" AFTER "9\"" (natural), not "10" before
//                   "4" (lexical). Falls back to text compare when no number.
//
// Both keep a leading placeholder ("— Unassigned —", "— None —", "", "All",
// etc.) pinned FIRST regardless of label, so callers that map a placeholder as
// the first <option> outside the list don't need to special-case it — but for
// lists that include the placeholder as a data row, sortOptions* float it up.
//
// LEAVE ALONE: document-status workflow enums and any list already ordered by
// an owner-controlled `sort_order` / `sortOrder` column — those encode a
// deliberate sequence, not findability.
// ----------------------------------------------------------------------------

// Keys we probe for an option's display text, in priority order. Covers the
// camelCase shapes (label/name/value/title) AND the snake_case row shapes the
// SCM query layer returns (material_name / *_code / supplier_sku), so a bare
// `sortByText(bindings)` sorts by what the <option> actually shows instead of
// silently no-op'ing. For a fully custom display string (e.g. fabricOptionLabel)
// callers pass the raw `byText` comparator with their own accessor.
const TEXT_KEYS = [
  'label', 'name', 'title',
  'material_name', 'materialName',
  'value',
  'code', 'material_code', 'materialCode',
  'supplier_sku', 'supplierSku',
  'account_code', 'accountCode',
  'fabric_description', 'fabricDescription',
  'fabric_code', 'fabricCode',
] as const;

/** Pull the label/text we sort on out of a raw option (string, number, or a
 *  row object — see TEXT_KEYS for the probed fields). */
function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  const o = v as Record<string, unknown>;
  for (const k of TEXT_KEYS) {
    const cand = o[k];
    if (typeof cand === 'string' && cand !== '') return cand;
    if (typeof cand === 'number') return String(cand);
  }
  return '';
}

/** Leading-number parse for natural numeric sort. `"10\""` → 10, `"5FT"` → 5,
 *  `"SK"` → NaN. Tolerates a leading sign / decimal. */
function leadingNumber(s: string): number {
  const m = s.trim().match(/^[-+]?\d*\.?\d+/);
  return m ? parseFloat(m[0]) : NaN;
}

/** Case-insensitive, locale-aware text comparator. */
export function byText(a: unknown, b: unknown): number {
  return textOf(a).localeCompare(textOf(b), undefined, { sensitivity: 'base' });
}

/** Numeric-ascending comparator on the leading number; ties / non-numeric
 *  fall back to text compare so "10\"" sorts after "9\"" but "Custom" still
 *  lands deterministically. */
export function byNumeric(a: unknown, b: unknown): number {
  const na = leadingNumber(textOf(a));
  const nb = leadingNumber(textOf(b));
  const aNum = !Number.isNaN(na);
  const bNum = !Number.isNaN(nb);
  if (aNum && bNum && na !== nb) return na - nb;
  if (aNum && !bNum) return -1; // numbers before non-numbers
  if (!aNum && bNum) return 1;
  return byText(a, b);
}

/** True for placeholder rows that must stay pinned first ("— None —",
 *  "— Unassigned —", "All", "", "-"). */
function isPlaceholder(v: unknown): boolean {
  const t = textOf(v).trim();
  if (t === '' || t === '-') return true;
  if (/^[—–-]\s*.*\s*[—–-]$/.test(t)) return true; // "— None —" style
  if (/^(all|none|unassigned|any)$/i.test(t)) return true;
  return false;
}

/** Return a NEW sorted copy (never mutates) ordered by `cmp`, with any
 *  placeholder row floated to the front. Use at the <option>/menu map site. */
export function sortOptions<T>(list: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return [...list].sort((a, b) => {
    const pa = isPlaceholder(a);
    const pb = isPlaceholder(b);
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    return cmp(a, b);
  });
}

/** Alphabetical sorted copy (placeholder-pinned). */
export function sortByText<T>(list: readonly T[]): T[] {
  return sortOptions(list, byText);
}

/** Numeric-ascending sorted copy (placeholder-pinned). */
export function sortByNumeric<T>(list: readonly T[]): T[] {
  return sortOptions(list, byNumeric);
}
