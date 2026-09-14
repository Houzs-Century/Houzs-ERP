// ----------------------------------------------------------------------------
// so-list-first-item-branding — the SO LIST's `first_item_category` +
// `first_item_branding`, as one pure function.
//
// The Sales Order list's Branding pill is
//   header branding (unless isPlaceholderBrandText) || brandingLabel(first_item_category, first_item_branding, company)
// (MfgSalesOrdersListV2.tsx / MobileSalesOrders.tsx `brandOf`). The two inputs
// were computed INLINE in the GET /mfg-sales-orders list handler, interleaved
// with its readiness aggregation, so nothing else could run the exact rule. The
// header-branding backfill (backend/scripts/backfill-so-header-branding.mjs,
// owner 2026-09-14) must write precisely what staff already see, so the rule
// moved here and the handler calls it — one home, two callers.
//
// so-display-branding.ts is a DIFFERENT, older copy (the detail page and the
// Sales report). It resolves the no-main-line fallback's category from the
// catalog, where the list reads the line's item_group; that divergence is
// recorded there and deliberately not changed here.
//
// THE RULE (unchanged from the handler, PR #266 + owner 2026-08-18):
//   1. rep line = the first line (in the order given) whose CATALOG-resolved
//      category is SOFA / BEDFRAME / MATTRESS;
//   2. no rep line -> the first line, category from its OWN item_group;
//   3. branding = that line's own `branding` text;
//   4. MATTRESS -> the SKU's branding wins when the catalog has one;
//   5. still blank and the order is bedframe-only (a BEDFRAME line, no
//      MATTRESS / SOFA line) -> the literal 'BEDFRAME'.
// A doc with no line is absent from the map — brandingLabel(null, ...) is then
// "No Items".
// ----------------------------------------------------------------------------

import { MAIN_CATEGORIES, normCategory } from './so-readiness';

export type ListBrandingLine = {
  doc_no: string;
  item_group: string | null;
  branding: string | null;
  item_code: string | null;
};

/**
 * The list LABEL as a HEADER value — or null when the label is not a brand.
 *
 * brandingLabel can print a category noun ("Accessory", "Mattress", "Other",
 * "No Items"), and the header is audited against the company's project_brands
 * (check-branding-vocabulary.mjs) and sent to AutoCount as the BRANDING UDF. So
 * a label becomes a header only when it IS a maintained brand: an exact member,
 * or a case-insensitive one written in the list's own spelling ("Bedframe" ->
 * Houzs's "BEDFRAME"). Shared by the create stamp and the header backfill, so a
 * new order and a backfilled one cannot land on different values.
 */
export function brandForHeader(label: string, brands: readonly string[]): string | null {
  const exact = brands.find((b) => b === label);
  if (exact) return exact;
  const lower = label.toLowerCase();
  return brands.find((b) => b.toLowerCase() === lower) ?? null;
}

/**
 * @param lines  the orders' LIVE (non-cancelled) lines, ordered by
 *               (doc_no, line_no ASC NULLS LAST, created_at ASC) — the order
 *               decides which line is "first", so the caller owns it.
 * @param productCategory  item code -> normCategory(mfg_products.category)
 * @param productBranding  item code -> mfg_products.branding, non-blank only
 */
export function deriveListFirstItemBranding(
  lines: ReadonlyArray<ListBrandingLine>,
  productCategory: ReadonlyMap<string, string>,
  productBranding: ReadonlyMap<string, string>,
): Map<string, { category: string | null; branding: string | null }> {
  const resolveLineCat = (code: string | null, group: string | null): string =>
    (code ? productCategory.get(code) : undefined) ?? normCategory(group);

  const first = new Map<string, ListBrandingLine>();
  const rep = new Map<string, { line: ListBrandingLine; cat: string }>();
  const cats = new Map<string, Set<string>>();
  for (const l of lines) {
    if (!first.has(l.doc_no)) first.set(l.doc_no, l);
    const cat = resolveLineCat(l.item_code, l.item_group);
    if (!rep.has(l.doc_no) && MAIN_CATEGORIES.has(cat)) rep.set(l.doc_no, { line: l, cat });
    let s = cats.get(l.doc_no);
    if (!s) { s = new Set(); cats.set(l.doc_no, s); }
    s.add(cat);
  }

  const out = new Map<string, { category: string | null; branding: string | null }>();
  for (const [docNo, firstLine] of first) {
    const r = rep.get(docNo);
    const line = r ? r.line : firstLine;
    const category = r ? r.cat : normCategory(firstLine.item_group);
    let branding = line.branding ?? null;
    if (category === 'MATTRESS') {
      const skuBrand = line.item_code ? productBranding.get(line.item_code) : undefined;
      if (skuBrand && skuBrand.trim()) branding = skuBrand;
    }
    if (!branding || !branding.trim()) {
      const s = cats.get(docNo);
      if (s && s.has('BEDFRAME') && !s.has('MATTRESS') && !s.has('SOFA')) branding = 'BEDFRAME';
    }
    out.set(docNo, { category, branding });
  }
  return out;
}
