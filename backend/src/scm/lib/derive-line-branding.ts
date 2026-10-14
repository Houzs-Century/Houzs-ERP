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
import { namesABrand } from './vp-brand';
import { activeCompanyId, activeCompanySql, scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { soHasDownstream } from './downstream-lock';

export type LineBrandingRow = {
  item_code?: string | null;
  branding?: string | null;
  company_id?: number | null;
};

const isBlank = (v: string | null | undefined) =>
  v == null || String(v).trim() === '';

/**
 * The header branding a CLIENT sent, or null when it is not a brand. A client
 * value that is blank, a placeholder or a category word ("BEDFRAME",
 * "Accessories") is never stored: the lines decide instead.
 */
export function clientHeaderBranding(v: unknown): string | null {
  return typeof v === 'string' && namesABrand(v) ? v.trim() : null;
}

type BrandListCtx = CompanyScopeCtx & { env: { DB: D1Database } };

/** The active company's maintained brands (project_brands), or null when the
 *  pool cannot be read — then the SKU-only answer stands. */
export async function loadHeaderBrandList(
  c: BrandListCtx,
): Promise<{ companyCode: string | null; brands: string[] } | null> {
  try {
    const brandRows = await c.env.DB.prepare(
      `SELECT name FROM project_brands WHERE active = 1${activeCompanySql(c)}`,
    ).all<{ name: string }>();
    return {
      companyCode: (c.get('companyCode') as string | undefined) ?? null,
      brands: brandRows.results.map((b) => String(b.name).trim()).filter(Boolean),
    };
  } catch { return null; }
}

/**
 * Re-derive an ERP order's HEADER branding after its lines changed (BUG-115).
 * Create stamps it once from the lines; without this a line added, swapped or
 * removed later (the usual fix-up of a scanned draft) left the header naming a
 * product the order no longer carries — HC-SO-2609-336, a Dunlopillo mattress
 * order headed BEDFRAME. Best-effort and non-fatal like the roll-up it sits by.
 *
 * Left alone: a migrated order (its header is AutoCount's copy), an order a
 * live DO / SI has snapshotted (the header identity lock), and any read that
 * fails. A brand change on an order whose fair verdict was computed from the
 * old brand and found no booth (AMBIGUOUS / UNMATCHED, no link) goes back to
 * PENDING so the nightly fair reconcile retries with the right brand.
 */
export async function restampHeaderBranding(
  sb: SupabaseClient,
  docNo: string,
  c: BrandListCtx,
): Promise<void> {
  try {
    const { data: head, error } = await scopeToCompany(
      sb.from('mfg_sales_orders').select('branding, linked_ac_docno, project_id, fair_match'),
      c,
    ).eq('doc_no', docNo).maybeSingle();
    if (error || !head) return;
    const h = head as { branding: string | null; linked_ac_docno: string | null; project_id: number | null; fair_match: string | null };
    if (h.linked_ac_docno) return;
    if (await soHasDownstream(sb, docNo)) return;
    const { data: lines, error: lErr } = await scopeToCompany(
      sb.from('mfg_sales_order_items').select('item_code, item_group, branding, company_id'),
      c,
    ).eq('doc_no', docNo).eq('cancelled', false)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });
    if (lErr) return;
    const brand = await deriveHeaderBrandingFromLines(
      sb,
      lines as Array<LineBrandingRow & { item_group?: string | null }>,
      activeCompanyId(c) ?? null,
      await loadHeaderBrandList(c),
    );
    if (!brand || brand === h.branding) return;
    const repend = fairRependsOnBrandChange(h);
    const companyId = activeCompanyId(c);
    if (companyId == null) return;
    await sb.from('mfg_sales_orders')
      .update(repend ? { branding: brand, fair_match: 'PENDING' } : { branding: brand })
      .eq('doc_no', docNo).eq('company_id', companyId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[restamp-header-branding] failed for', docNo, e);
  }
}

/** A brand change re-opens a fair verdict that found no booth under the old
 *  brand, so the nightly reconcile retries it (PENDING). */
export function fairRependsOnBrandChange(h: { project_id: number | null; fair_match: string | null }): boolean {
  return h.project_id == null && (h.fair_match === 'AMBIGUOUS' || h.fair_match === 'UNMATCHED');
}

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

  const products: HeaderBrandingProduct[] = [];
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
    products.push(...((data ?? []) as HeaderBrandingProduct[]));
  }
  return pickHeaderBranding(rows, products, listFallback);
}

export type HeaderBrandingProduct = { code: string; branding: string | null; category: string | null };

/**
 * The pure half of deriveHeaderBrandingFromLines: the header brand for these
 * live lines (in line order) given this company's catalogue rows for their
 * codes. Exported so backend/scripts/check-so-header-branding.mjs judges old
 * orders by this exact rule, not a copy of it.
 */
export function pickHeaderBranding(
  rows: Array<LineBrandingRow & { item_group?: string | null }>,
  products: readonly HeaderBrandingProduct[],
  listFallback: { companyCode: string | null; brands: readonly string[] } | null,
): string | null {
  if (!rows.some((r) => !isBlank(r.item_code))) return null;
  const brandByCode = new Map<string, string>();
  const catByCode = new Map<string, string>();
  for (const p of products) {
    if (!isBlank(p.branding)) brandByCode.set(p.code, p.branding!.trim());
    if (p.category) catByCode.set(p.code, p.category.trim().toUpperCase());
  }

  const isMain = (code: string | null | undefined): boolean => {
    const cat = code ? catByCode.get(code) : undefined;
    return !!cat && (cat.includes('SOFA') || cat.includes('BEDFRAME') || cat.includes('MATTRESS'));
  };
  /* A BRAND beats a category word (BUG-115 / HC-0094, Chew 2026-10-13: "based
     on our branding (Akemi, Dunlopillo, Zanotti, My Latex)"). The first main
     line that names a real brand wins, so a bedframe keyed before a Dunlopillo
     mattress no longer stamps BEDFRAME. A sofa with an unbranded SKU names its
     house brand through the list rule (ZANOTTI). */
  for (const r of rows) {
    if (!r.item_code || !isMain(r.item_code)) continue;
    let candidate = brandByCode.get(r.item_code) ?? null;
    if (!candidate && listFallback && listFallback.brands.length > 0) {
      const cat = normCategory(catByCode.get(r.item_code));
      candidate = brandForHeader(brandingLabel(cat, null, listFallback.companyCode), listFallback.brands);
    }
    if (candidate && namesABrand(candidate)) return candidate;
  }

  /* No line names a brand: the order's category is all there is to say (a
     bedframe-only Houzs order is BEDFRAME, which is in Houzs's own list). */
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
