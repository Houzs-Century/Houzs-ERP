// ----------------------------------------------------------------------------
// vp-brand -- which brand a bill is FOR, asked for the Venture Portal only
// (owner 2026-09-27).
//
// The portal pays Revenue commission on a margin ladder, and the ladder is the
// bill's brand. This system works `branding` out from the products
// (derive-line-branding.ts), so a bill of bed frames or accessories alone comes
// out BEDFRAME, SERVICE, NONE or blank -- a kind of goods, not a brand. Those
// bills are never sold on their own: a bed frame or a pillow is a SECOND bill
// written at a brand's fair, and it follows that fair's brand (owner: "the
// fair is Akemi, it follows the Akemi margin ladder").
//
// So when NOTHING on the bill names a brand -- not its header, not one of its
// lines (owner: only when none of the products has branding) -- the order form
// asks which brand the bill is for, pre-set to the brand of the booth the fair
// picker linked. The choices are the brands the portal has a margin ladder for
// (sync_config `vp.brands`, owner: "just follow VP"), in this company's list
// order. The answer is optional -- some bills need none -- and lives in its own
// column, mfg_sales_orders.vp_brand, which nothing in this system reads:
// `branding` and everything that hangs off it (AutoCount, booth matching, the
// letterhead) are exactly as before. The feed sends it as `vpBrand`.
//
// Pure: the reads are in vp-brand-ask.ts.
// ----------------------------------------------------------------------------

import { CATEGORY_SOURCES, isPlaceholderBrandText } from '../shared/so-branding-label';

/** Brand-list entries that say what KIND of goods a bill carries, not whose
 *  brand (BEDFRAME, SERVICE, OTHERS ...). They stay valid `branding` values;
 *  they never count as a brand here. Built from the one list of categories
 *  the system can produce (CATEGORY_SOURCES), not a second copy of it — plus
 *  the plural 2990's brand list spells. */
export const NOT_A_BRAND: ReadonlySet<string> = new Set<string>([
  ...CATEGORY_SOURCES.productEnum,
  ...CATEGORY_SOURCES.normBuckets,
  'ACCESSORIES',
]);

const key = (s: string): string => s.trim().toUpperCase();

/** Whether a branding value names a brand: not blank, not a placeholder the
 *  floor types for "no brand" (NONE, N/A ...), not a kind of goods. */
export function namesABrand(value: string | null): boolean {
  if (value == null || isPlaceholderBrandText(value)) return false;
  return !NOT_A_BRAND.has(key(value));
}

/** The `vp.brands` setting -- the brands the portal pays a margin ladder on --
 *  as a list: comma-separated, spaces and repeats ignored. */
export function parseVpBrands(value: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (value ?? '').split(',')) {
    const name = part.trim();
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    out.push(name);
  }
  return out;
}

/** The brands a bill can belong to: this company's active brand list, in its
 *  own order and spelling, keeping only the ones the portal pays on. */
export function vpBrandOptions(brands: readonly string[], portalBrands: readonly string[]): string[] {
  const paid = new Set(portalBrands.map(key));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of brands) {
    const name = raw.trim();
    const k = key(name);
    if (!namesABrand(name) || !paid.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

/** The option a value names, ignoring case and spaces, in the list's own
 *  spelling -- or null when it names none of them. */
export function matchVpBrand(value: string | null, options: readonly string[]): string | null {
  if (value == null) return null;
  const k = key(value);
  if (!k) return null;
  return options.find((o) => key(o) === k) ?? null;
}

/** What the order form is told after a save: ask, with these choices. */
export type VpBrandAsk = { suggested: string | null; options: string[] };

/**
 * Whether to ask which brand a bill is for -- only when neither its `branding`
 * nor ANY of its lines' names a brand, and nobody has answered yet. A line
 * with a brand of its own (a Dunlopillo pillow beside a bed frame) settles it:
 * no question. `boothBrand` is the brand of the booth the fair picker linked
 * (projects.brand), offered as the suggestion when it is one of the choices.
 */
export function vpBrandAsk(input: {
  branding: string | null;
  lineBrandings: readonly (string | null)[];
  current: string | null;
  boothBrand: string | null;
  options: readonly string[];
}): VpBrandAsk | null {
  if (input.options.length === 0) return null;
  if (input.current != null && input.current.trim() !== '') return null;
  if (namesABrand(input.branding)) return null;
  if (input.lineBrandings.some(namesABrand)) return null;
  return { suggested: matchVpBrand(input.boothBrand, input.options), options: [...input.options] };
}
