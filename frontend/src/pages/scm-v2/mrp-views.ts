/* ----------------------------------------------------------------------------
   mrp-views — the MRP page's tab list, derived from the catalogue the SERVER
   reports rather than typed here.

   WHY IT IS DERIVED. A tab is not decoration on this page: it is the ONLY way a
   demand row can be seen. The page asks for `?category=<the tab>` and the engine
   drops everything else before rendering (`if (catFilter && cat !== catFilter)
   continue`, mrp.ts section 6, with no tally), then the page filters what
   survives again with `s.category === <the tab>`. So a category with no tab is a
   category whose demand is planned, given a real quantity, and shown NOWHERE —
   no empty state, no count, no warning. A missing row and a covered row look
   identical here, which is why this class is found on delivery day.

   The four hard-coded tabs were written when `mfg_product_category` had five
   members. It has NINE: migrations 0258-0261 (and their scm twins 0262-0265)
   added DINING, BEDLINES, DIFFUSER and CARPET so the AutoCount catalogue could
   be tagged, and backend/scripts/data/align-skus-houzs-century.json — the
   committed payload align-open-skus.mjs writes into scm.mfg_products for
   company 1 — opens 181 SKUs across those four. Every one of them was stranded.

   `MrpResponse.categories` has carried the answer the whole time: the distinct
   category of every product in the company's catalogue, paged, company-scoped,
   and independent of the category filter (mrp.ts section 2, whose own comment
   calls it "the tab list"). The page simply never read it. Reading it is what
   makes the two expressions ONE.

   WHAT THIS DOES NOT DO: invent a category, or write a second label table. The
   noun comes from `brandingCategoryNoun`, which is already the one total
   category -> noun function here, and a category it has never heard of is Title
   Cased and shown rather than dropped — for exactly the reason recorded there,
   that a category added to the enum tomorrow must still print something true
   about itself.
   ---------------------------------------------------------------------------- */

import { brandingCategoryNoun } from '../../vendor/shared/so-branding-label';

export type MrpView = {
  /** The tab's own id — the lower-cased category. */
  value: string;
  /** The `?category=` the tab asks the server for, and the value a row's
   *  `category` must equal to render on it. ONE string, both jobs. */
  category: string;
  label: string;
};

/* SERVICE is the one member that legitimately has no tab: `isServiceLine` skips
   service lines BEFORE the category filter ("they never create purchase
   demand", mrp.ts), so a Service tab could only ever be empty. Named here
   rather than filtered out silently. */
const NEVER_A_TAB = new Set(['SERVICE']);

/* The four that shipped, with the labels the page has always shown (the
   accessory tab is plural here and singular in `brandingCategoryNoun`, which is
   a wording difference on one screen, not a second rule). They stand even when
   `categories` is absent — a response still in flight, or from a backend
   predating the field, must not blank the tab bar. */
const BASE: readonly MrpView[] = [
  { value: 'sofa', category: 'SOFA', label: 'Sofa' },
  { value: 'bedframe', category: 'BEDFRAME', label: 'Bedframe' },
  { value: 'mattress', category: 'MATTRESS', label: 'Mattress' },
  { value: 'accessory', category: 'ACCESSORY', label: 'Accessories' },
];

/* THE LABEL IS NOT WRITTEN HERE. `brandingCategoryNoun` is already the ONE
   total category -> noun function in this codebase — it takes the raw enum
   values, carries the four added members, and Title Cases anything it has never
   heard of rather than printing nothing. A second noun table on this page would
   be the same duplicated-decision the tab list itself was
   (backend/scripts/check-duplicated-decisions.mjs catches it). */

/**
 * The `?category=` a tab id asks for.
 *
 * THE INVERSE OF `value` BELOW, AND THE REASON THIS IS A FUNCTION. The page has
 * to know which category to REQUEST before it has a response to derive tabs
 * from, so the tab id and the category it means cannot be related by a lookup
 * into the derived list without a cycle. They are related by this one pair of
 * expressions instead, and `mrp-views.test.ts` pins the round-trip on every tab
 * — which is the whole point: a tab whose id says one thing while its rows are
 * filtered by another is this bug with extra steps.
 */
export function mrpCategoryOf(value: string): string {
  return (value ?? '').trim().toUpperCase();
}

/** The tab id for a category — the inverse of `mrpCategoryOf`. */
function tabValueOf(category: string): string {
  return category.toLowerCase();
}

/**
 * The tabs to render for a plan whose catalogue holds `categories`.
 *
 * The four originals first, then every other catalogue category in the order
 * the server sent them. Duplicates and SERVICE are dropped; nothing else is.
 */
export function mrpViews(categories: readonly string[] | undefined): MrpView[] {
  const views: MrpView[] = BASE.filter((v) => !NEVER_A_TAB.has(v.category)).map((v) => ({ ...v }));
  const seen = new Set(views.map((v) => v.category));
  for (const raw of categories ?? []) {
    const cat = (raw ?? '').trim().toUpperCase();
    if (!cat || seen.has(cat) || NEVER_A_TAB.has(cat)) continue;
    seen.add(cat);
    views.push({ value: tabValueOf(cat), category: cat, label: brandingCategoryNoun(cat).noun });
  }
  return views;
}
