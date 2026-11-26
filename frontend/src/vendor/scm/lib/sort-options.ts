
const TEXT_KEYS = [
  'label', 'name', 'title',
  'material_name', 'materialName',
  'value',
  'code', 'item_code', 'itemCode',
  'supplier_sku', 'supplierSku',
  'account_code', 'accountCode',
  'fabric_description', 'fabricDescription',
  'fabric_code', 'fabricCode',
] as const;

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
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  return byText(a, b);
}

function isPlaceholder(v: unknown): boolean {
  const t = textOf(v).trim();
  if (t === '' || t === '-') return true;
  if (/^[—–-]\s*.*\s*[—–-]$/.test(t)) return true;
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
