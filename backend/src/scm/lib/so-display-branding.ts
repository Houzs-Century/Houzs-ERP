
import { chunkIn } from './paginate-all';
import { scopeToCompany } from './companyScope';
import type { CompanyScopeCtx } from './companyScope';
import { normCategory } from './so-readiness';
import { pgrestIn } from './pgrest-in-list';

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
  const rows = await deriveDisplayBrandingRowByDoc(sb, c, docNos);
  const flat = new Map<string, string>();
  for (const [docNo, row] of rows) if (row.branding) flat.set(docNo, row.branding);
  return flat;
}

/** The representative line's resolved CATEGORY alongside its branding text —
 *  the two inputs `brandingLabel` needs. Added 2026-08-18 so the SO DETAIL page
 *  can render the same label as the list instead of its own
 *  `branding || first_item_branding || "—"`, which printed a dash for any order
 *  whose rep line carries no brand text (i.e. every sofa). `branding` is null
 *  when nothing resolved; `category` is null only when the doc has no readable
 *  line, which is what makes "No Items" distinguishable from a blank brand. */
export async function deriveDisplayBrandingRowByDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  c: CompanyScopeCtx,
  docNos: string[],
): Promise<Map<string, { category: string | null; branding: string | null }>> {
  const out = new Map<string, { category: string | null; branding: string | null }>();
  const uniq = Array.from(new Set(docNos.filter(Boolean)));
  if (uniq.length === 0) return out;

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
  if (error) return out;
  const lines = (lineData ?? []) as LineRow[];
  if (lines.length === 0) return out;

  const codes = Array.from(new Set(lines.map((l) => l.item_code).filter((v): v is string => !!v)));
  const productCategory = new Map<string, string>();
  const productBranding = new Map<string, string>();
  for (let i = 0; i < codes.length; i += 300) {
    const chunk = codes.slice(i, i + 300);
    const { data: prodRows, error: prodErr } = await scopeToCompany(
      pgrestIn(sb.from('mfg_products').select('code, category, branding'), 'code', chunk),
      c,
    );
    if (prodErr) {
      // eslint-disable-next-line no-console
      console.error('[so-display-branding] mfg_products read failed:', (prodErr as { message?: unknown }).message ?? prodErr);
    }
    for (const p of (prodRows ?? []) as Array<{ code: string; category: string | null; branding: string | null }>) {
      if (p.category) productCategory.set(p.code, normCategory(p.category));
      if (!isBlank(p.branding)) productBranding.set(p.code, p.branding!.trim());
    }
  }
  const resolveLineCat = (l: LineRow): string =>
    (l.item_code ? productCategory.get(l.item_code) : undefined) ?? normCategory(l.item_group);

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
    if (resolveLineCat(rep) === 'MATTRESS' && rep.item_code) {
      const skuBrand = productBranding.get(rep.item_code);
      if (!isBlank(skuBrand)) brand = skuBrand!;
    }
    if (isBlank(brand)) {
      const s = catsByDoc.get(docNo);
      if (s && s.has('BEDFRAME') && !s.has('MATTRESS') && !s.has('SOFA')) brand = 'BEDFRAME';
    }
    out.set(docNo, {
      category: resolveLineCat(rep),
      branding: isBlank(brand) ? null : String(brand).trim(),
    });
  }
  return out;
}
