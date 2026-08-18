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
      let q = sb.from('mfg_products').select('code, branding').in('code', chunk);
      if (cid != null) q = q.eq('company_id', cid);
      const { data } = await q;
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
  rows: LineBrandingRow[],
  fallbackCompanyId: number | null,
): Promise<string | null> {
  const codes = Array.from(new Set(
    rows.map((r) => r.item_code).filter((v): v is string => !!v && v.trim() !== ''),
  ));
  if (codes.length === 0) return null;
  const cid = rows.find((r) => r.company_id != null)?.company_id ?? fallbackCompanyId;

  const brandByCode = new Map<string, string>();
  const catByCode = new Map<string, string>();
  for (let i = 0; i < codes.length; i += 300) {
    let q = sb.from('mfg_products').select('code, branding, category').in('code', codes.slice(i, i + 300));
    if (cid != null) q = q.eq('company_id', cid);
    const { data } = await q;
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
  return brand ?? null;
}
