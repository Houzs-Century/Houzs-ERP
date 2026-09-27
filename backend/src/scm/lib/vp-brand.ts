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
// So when the products name no brand, the order form asks which brand the bill
// is for, pre-set to the brand of the booth the fair picker linked. The answer
// is optional -- some bills need none -- and lives in its own column,
// mfg_sales_orders.vp_brand, which nothing in this system reads: `branding`
// and everything that hangs off it (AutoCount, booth matching, the letterhead)
// are exactly as before. The feed sends it as `vpBrand`.
//
// Pure: the reads are in vp-brand-ask.ts.
// ----------------------------------------------------------------------------

/** Brand-list entries that say what KIND of goods a bill carries, not whose
 *  brand. They stay valid `branding` values; they are never an answer here. */
export const NOT_A_BRAND: ReadonlySet<string> = new Set([
  'BEDFRAME', 'SERVICE', 'OTHERS', 'OTHER', 'NONE', 'ACCESSORY', 'ACCESSORIES', 'MATTRESS', 'SOFA',
]);

const key = (s: string): string => s.trim().toUpperCase();

/** The brands a bill can belong to: the company's active brand list in its own
 *  order and spelling, without the kinds of goods and without repeats. */
export function vpBrandOptions(brands: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of brands) {
    const name = raw.trim();
    const k = key(name);
    if (!name || NOT_A_BRAND.has(k) || seen.has(k)) continue;
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
 * Whether to ask which brand a bill is for -- only when its own `branding`
 * names no brand and nobody has answered yet. `boothBrand` is the brand of the
 * booth the fair picker linked (projects.brand), offered as the suggestion when
 * it is one of the choices.
 */
export function vpBrandAsk(input: {
  branding: string | null;
  current: string | null;
  boothBrand: string | null;
  options: readonly string[];
}): VpBrandAsk | null {
  if (input.options.length === 0) return null;
  if (input.current != null && input.current.trim() !== '') return null;
  if (matchVpBrand(input.branding, input.options) != null) return null;
  return { suggested: matchVpBrand(input.boothBrand, input.options), options: [...input.options] };
}
