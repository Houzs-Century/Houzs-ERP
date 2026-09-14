// Auto-derive `branding` for SO/DO/consignment line rows from the product
// catalog. Called BEFORE any INSERT of new item rows so the "SO Branding is
// blank" bug can't reoccur.
//
// Owner rule (2026-07-23, Loo): "by default 从 SKU 就可以知道是什么 brand".
// Manual per-line branding entry is not a workflow — the SO CREATE form has
// never exposed a branding field, and 2990's imported SOs (68 orders, 203
// items) all landed with NULL line branding because the source system had
// the same gap. Rather than adding a UI field, we resolve branding from the
// product catalog on save — the ONE place that already knows the answer.
//
// Non-destructive: a caller-supplied branding always wins. Only NULL / blank
// rows are filled. Codes not found in the catalog stay blank (the SO list's
// existing category-based fallbacks — MATTRESS → mfg_products.branding,
// BEDFRAME-only → "BEDFRAME" — still apply on the derive path in the /list
// handler; this fill just closes the common case at write time).

import type { SupabaseClient } from '@supabase/supabase-js';
import { pgrestIn } from './pgrest-in-list';
import { normCategory } from './so-readiness';
import { brandForHeader, deriveListFirstItemBranding } from './so-list-first-item-branding';
import { brandingLabel } from '../shared/so-branding-label';

export type LineBrandingRow = {
  item_code?: string | null;
  branding?: string | null;
  company_id?: number | null;
};

const isBlank = (v: string | null | undefined) =>
  v == null || String(v).trim() === '';

/**
 * Fill in `branding` in place from `scm.mfg_products.branding` for any row
 * that has an item_code but no branding. Scoped per-company (mfg_products is
 * company-scoped since mig 0061); rows without a company_id fall back to
 * `fallbackCompanyId` (typically the active caller's company).
 */
export async function deriveLineBrandingFromProduct(
  sb: SupabaseClient,
  rows: LineBrandingRow[],
  fallbackCompanyId: number | null,
): Promise<void> {
  // Group codes that need lookup by their effective company_id so we can hit
  // the catalog with a single .in() per company (bounded chunks below).
  const need = new Map<number | null, Set<string>>();
  for (const r of rows) {
    if (!isBlank(r.branding) || !r.item_code) continue;
    const cid = r.company_id ?? fallbackCompanyId;
    if (!need.has(cid)) need.set(cid, new Set());
    need.get(cid)!.add(r.item_code);
  }
  if (need.size === 0) return;

  // key = `${cid ?? 0}:${code}` — same convention we look up with below.
  const brandByKey = new Map<string, string>();
  for (const [cid, codeSet] of need) {
    const codes = [...codeSet];
    for (let i = 0; i < codes.length; i += 300) {
      const chunk = codes.slice(i, i + 300);
      let q = pgrestIn(sb.from('mfg_products').select('code, branding'), 'code', chunk);
      if (cid != null) q = q.eq('company_id', cid);
      const { data, error } = await q;
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[derive-line-branding] mfg_products branding read failed:', (error as { message?: unknown }).message ?? error);
      }
      for (const p of (data ?? []) as Array<{ code: string; branding: string | null }>) {
        if (!isBlank(p.branding)) {
          brandByKey.set(`${cid ?? 0}:${p.code}`, p.branding!.trim());
        }
      }
    }
  }

  for (const r of rows) {
    if (!isBlank(r.branding) || !r.item_code) continue;
    const cid = r.company_id ?? fallbackCompanyId;
    const brand = brandByKey.get(`${cid ?? 0}:${r.item_code}`);
    if (brand) r.branding = brand;
  }
}

/**
 * The SO HEADER's branding, taken from the representative LINE's SKU.
 *
 * WHY THE HEADER IS STAMPED AT ALL. Owner 2026-08-18: "我要表头啊" — the SO
 * list renders the header first and falls back to a derived label only when it
 * is blank. Every Houzs order already has one, because AutoCount sends it; no
 * ERP-created order ever did, because the CREATE form has never exposed a
 * branding field (`branding: body.branding ?? null` is the whole of it). So
 * 2990's 100 orders were blank and a backfill was needed to fill them —
 * and without this stamp the very next order created would need one too.
 *
 * WHY THE SKU AND NOT THE DISPLAY LABEL. brandingLabel prints "Accessory" for
 * an accessory order while 2990's brand list (project_brands, maintained in
 * PMS) holds "Accessories"; the label would write a value the owner's own
 * dropdown does not contain. Every SKU branding IS a member of that list —
 * measured 2026-08-18, 353 of 353 for 2990 and every Houzs SKU too — so
 * copying the catalogue keeps the header inside the vocabulary by
 * construction, which is what check-branding-vocabulary.mjs asserts.
 *
 * REPRESENTATIVE LINE = the first line whose CATALOG-resolved category is a
 * main product (SOFA / BEDFRAME / MATTRESS), falling back to the first line
 * when the order has none. Same pick the SO list's label rule makes, so the
 * stamped header and the derived label cannot disagree about which line spoke.
 *
 * Returns null when nothing resolves — no lines, no item codes, or a rep line
 * whose SKU carries no branding. A null means LEAVE THE HEADER BLANK: the list
 * still derives a label, and inventing a value here would put a guess into a
 * column the owner reads as fact.
 */
export async function deriveHeaderBrandingFromLines(
  sb: SupabaseClient,
  rows: Array<LineBrandingRow & { item_group?: string | null }>,
  fallbackCompanyId: number | null,
  /* WHEN THE SKU SAYS NOTHING, the brand the SO LIST shows — if it is one of
     the company's maintained brands (2026-09-14). Without it a Houzs sofa whose
     SKU carries no branding (the 5526 family) was created with a NULL header
     while the list printed ZANOTTI, and the Branding filter could not find it:
     HC-SO-2609-065 / -071 / -072 on production. null = no brand list could be
     read, and then the SKU-only answer stands. Required, not optional: its
     absence changes the answer. */
  listFallback: { companyCode: string | null; brands: readonly string[] } | null,
): Promise<string | null> {
  const codes = Array.from(new Set(
    rows.map((r) => r.item_code).filter((v): v is string => !!v && v.trim() !== ''),
  ));
  if (codes.length === 0) return null;
  const cid = rows.find((r) => r.company_id != null)?.company_id ?? fallbackCompanyId;

  const brandByCode = new Map<string, string>();
  const catByCode = new Map<string, string>();
  for (let i = 0; i < codes.length; i += 300) {
    let q = pgrestIn(sb.from('mfg_products').select('code, branding, category'), 'code', codes.slice(i, i + 300));
    if (cid != null) q = q.eq('company_id', cid);
    const { data, error } = await q;
    /* An unreadable catalogue is NOT "this SKU has no brand". Swallowing it via
       `data ?? []` would stamp a header derived from a partial catalogue, or
       leave it blank while looking like a considered decision. Return null so
       the caller leaves the header alone, and the SO list still derives a label
       from the lines. */
    if (error) return null;
    for (const p of (data ?? []) as Array<{ code: string; branding: string | null; category: string | null }>) {
      if (!isBlank(p.branding)) brandByCode.set(p.code, p.branding!.trim());
      if (p.category) catByCode.set(p.code, p.category.trim().toUpperCase());
    }
  }

  const isMain = (code: string | null | undefined): boolean => {
    const cat = code ? catByCode.get(code) : undefined;
    return !!cat && (cat.includes('SOFA') || cat.includes('BEDFRAME') || cat.includes('MATTRESS'));
  };
  const rep = rows.find((r) => isMain(r.item_code)) ?? rows[0];
  const brand = rep?.item_code ? brandByCode.get(rep.item_code) : undefined;
  if (brand) return brand;
  if (!listFallback || listFallback.brands.length === 0) return null;

  /* The list's own rule, over these rows in the order the create inserts them
     (line_no = array index), so the header matches the Branding pill. */
  const productCategory = new Map<string, string>();
  for (const [code, cat] of catByCode) productCategory.set(code, normCategory(cat));
  const first = deriveListFirstItemBranding(
    rows.map((r) => ({ doc_no: '', item_group: r.item_group ?? null, branding: r.branding ?? null, item_code: r.item_code ?? null })),
    productCategory,
    brandByCode,
  ).get('');
  const label = brandingLabel(first?.category ?? null, first?.branding ?? null, listFallback.companyCode);
  return brandForHeader(label, listFallback.brands);
}
