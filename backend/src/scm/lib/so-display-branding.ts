// ----------------------------------------------------------------------------
// so-display-branding — derive the DISPLAY branding for a set of Sales Orders
// from their item lines + the product catalog.
//
// The SO header's `branding` column is NULL for essentially every order: the
// create form has never exposed a branding field (see derive-line-branding.ts).
// What the SO list actually shows is `first_item_branding`, computed inline in
// the /mfg-sales-orders LIST handler (PR #266, catalog-resolved + mains-first):
//
//   1. rep line  = the SO's first non-cancelled line whose CATALOG-resolved
//                  category is a MAIN (SOFA / BEDFRAME / MATTRESS), falling
//                  back to the earliest line when there is none;
//   2. branding  = that line's own `branding` text;
//   3. MATTRESS fallback — a blank mattress line borrows mfg_products.branding;
//   4. bedframe-only SO (>=1 BEDFRAME line, no MATTRESS/SOFA) -> "BEDFRAME"
//      (Commander 2026-07-16), only when no explicit brand text is present.
//
// This module is that same rule as a reusable helper, so OTHER readers of SO
// branding (the Fair/Sales Report was the first: its Branding column read the
// raw header and rendered a dash on every row) resolve the identical value the
// SO list shows. The list handler still carries its inline copy interwoven
// with its readiness aggregation — consolidating it onto this helper is a
// follow-up; if you change the rule, change BOTH until then.
//
// NOTE (2026-08-17): the two exports here are DIFFERENT rules and always have
// been, which is worth knowing before you assume a fix to one touched the
// other.
//   · deriveBranding (re-exported from ../shared/so-branding-label) maps a
//     CATEGORY to a display label — "2990 Sofa", "Bedframe", "Service".
//   · deriveDisplayBrandingByDoc, below, returns the line's RAW branding text
//     and the literal "BEDFRAME" (upper case, not "Bedframe") for a
//     bedframe-only order, and omits a doc entirely when nothing resolves.
// So the Sales Report and the SO detail can show a different string than the
// SO list for the same order, and a doc missing from the map still renders a
// dash upstream. That divergence is NOT fixed here — see the PR's deferred
// list. Only the label rule was made total.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';
import { scopeToCompany } from './companyScope';
import type { CompanyScopeCtx } from './companyScope';
import { normCategory } from './so-readiness';

const MAIN_CATS = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);

const isBlank = (v: string | null | undefined) => v == null || String(v).trim() === '';

/**
 * The SO list Branding column, as a pure rule.
 *
 * THE RULE ITSELF NOW LIVES IN ../shared/so-branding-label.ts and this is its
 * name at the call sites that already had it. Two reasons it moved:
 *
 *  1. IT WAS WRITTEN TWICE. The comment this function used to carry said the
 *     frontend copy in ConsignmentOrders.tsx was "behaviourally identical
 *     today, verified 2026-08-15" and left it alone. Two homes and a date is
 *     not a guarantee; the shared/ directory is mirrored into
 *     frontend/src/vendor/shared/ and check-shared-mirrors.mjs --strict fails
 *     CI when the two drift (.github/workflows/ci.yml:151). That copy is now
 *     deleted and the page imports the mirror.
 *
 *  2. IT RETURNED THE EMPTY STRING for ACCESSORY / SERVICE / OTHERS and for an
 *     order with no readable line — and for ANY raw item_group text, because
 *     it compared categories with === against normalised values only. Owner
 *     2026-08-17: a service order still says "Service"; there should be no
 *     blank branding. The shared rule can no longer return "" for any input
 *     and so-display-branding.test.ts proves it as a property.
 *
 * `companyCode` is new and OPTIONAL: omitted, the labels read exactly as they
 * did before (the 2990 house-brand wording), so every existing caller keeps
 * its behaviour until it passes the company it is rendering for.
 */
export { brandingLabel as deriveBranding } from '../shared/so-branding-label';


type LineRow = {
  doc_no: string;
  item_group: string | null;
  branding: string | null;
  item_code: string | null;
};

/**
 * doc_no -> derived display branding for every doc where one could be
 * resolved. Docs with no resolvable brand are simply absent from the map.
 * Queries are company-scoped through the caller's context, chunked and
 * paginated, so a large report window cannot hit the PostgREST row cap.
 */
export async function deriveDisplayBrandingByDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  c: CompanyScopeCtx,
  docNos: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = Array.from(new Set(docNos.filter(Boolean)));
  if (uniq.length === 0) return out;

  /* Lines, ordered so the FIRST row seen per doc is its earliest line —
     the same (doc_no, line_no, created_at) order the list handler uses. */
  const { data: lineData, error } = await chunkIn<LineRow>(uniq, (batch, from, to) =>
    scopeToCompany(
      sb.from('mfg_sales_order_items')
        .select('doc_no, item_group, branding, item_code')
        .in('doc_no', batch)
        .eq('cancelled', false),
      c,
    )
      .order('doc_no')
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to));
  if (error) return out; // best-effort: an unreadable line set derives nothing
  const lines = (lineData ?? []) as LineRow[];
  if (lines.length === 0) return out;

  /* Catalog category + branding for every code in view (chunked .in). */
  const codes = Array.from(new Set(lines.map((l) => l.item_code).filter((v): v is string => !!v)));
  const productCategory = new Map<string, string>();
  const productBranding = new Map<string, string>();
  for (let i = 0; i < codes.length; i += 300) {
    const chunk = codes.slice(i, i + 300);
    const { data: prodRows } = await scopeToCompany(
      sb.from('mfg_products').select('code, category, branding').in('code', chunk),
      c,
    );
    for (const p of (prodRows ?? []) as Array<{ code: string; category: string | null; branding: string | null }>) {
      if (p.category) productCategory.set(p.code, normCategory(p.category));
      if (!isBlank(p.branding)) productBranding.set(p.code, p.branding!.trim());
    }
  }
  const resolveLineCat = (l: LineRow): string =>
    (l.item_code ? productCategory.get(l.item_code) : undefined) ?? normCategory(l.item_group);

  /* One ordered pass: earliest line, first MAIN line, and the resolved
     category set per doc (for the bedframe-only rule). */
  const firstLine = new Map<string, LineRow>();
  const repLine = new Map<string, LineRow>();
  const catsByDoc = new Map<string, Set<string>>();
  for (const l of lines) {
    if (!firstLine.has(l.doc_no)) firstLine.set(l.doc_no, l);
    const cat = resolveLineCat(l);
    if (!repLine.has(l.doc_no) && MAIN_CATS.has(cat)) repLine.set(l.doc_no, l);
    let s = catsByDoc.get(l.doc_no);
    if (!s) { s = new Set(); catsByDoc.set(l.doc_no, s); }
    s.add(cat);
  }

  for (const docNo of uniq) {
    const rep = repLine.get(docNo) ?? firstLine.get(docNo);
    if (!rep) continue;
    let brand = rep.branding;
    if (isBlank(brand) && resolveLineCat(rep) === 'MATTRESS' && rep.item_code) {
      brand = productBranding.get(rep.item_code) ?? brand;
    }
    if (isBlank(brand)) {
      const s = catsByDoc.get(docNo);
      if (s && s.has('BEDFRAME') && !s.has('MATTRESS') && !s.has('SOFA')) brand = 'BEDFRAME';
    }
    if (!isBlank(brand)) out.set(docNo, String(brand).trim());
  }
  return out;
}
