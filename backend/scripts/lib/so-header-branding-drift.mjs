/* Which sales-order HEADERS hold a branding the BUG-115 rule would not stamp
   today, and which of those the app itself would leave alone.

   The rule is not copied: pickHeaderBranding and fairRependsOnBrandChange are
   the functions restampHeaderBranding runs after every line add / edit /
   delete (src/scm/lib/derive-line-branding.ts). This file only applies the
   same skips restampHeaderBranding applies, over rows a script has read:
     - a derived null never overwrites anything;
     - an exact match is not drift;
     - linked_ac_docno set   -> skipped (AutoCount's copy of the header);
     - a live DO / SI exists -> skipped (the header identity lock). */
import { fairRependsOnBrandChange, pickHeaderBranding } from "../../src/scm/lib/derive-line-branding.ts";

/**
 * @param {object} input
 * @param {Array<{doc_no: string, branding: string|null, status: string|null, linked_ac_docno: string|null, project_id: number|null, fair_match: string|null}>} input.heads
 * @param {Array<{doc_no: string, item_code: string|null, item_group: string|null, branding: string|null}>} input.lines
 *   live (cancelled = false) lines, ordered line_no ASC NULLS LAST, created_at ASC
 * @param {Array<{code: string, branding: string|null, category: string|null}>} input.products  this company's catalogue
 * @param {{companyCode: string|null, brands: string[]} | null} input.listFallback
 * @param {Set<string>} input.downstream  doc_nos with a live DO or SI
 */
export function classifyHeaderBranding({ heads, lines, products, listFallback, downstream }) {
  const byDoc = new Map();
  for (const l of lines) {
    if (!byDoc.has(l.doc_no)) byDoc.set(l.doc_no, []);
    byDoc.get(l.doc_no).push(l);
  }
  const affected = [];
  const skippedMigrated = [];
  const skippedDownstream = [];
  for (const h of heads) {
    if (h.status === "CANCELLED") continue;
    const derived = pickHeaderBranding(byDoc.get(h.doc_no) ?? [], products, listFallback);
    if (!derived || derived === h.branding) continue;
    const row = { ...h, derived, repend: fairRependsOnBrandChange(h) };
    if (h.linked_ac_docno) skippedMigrated.push(row);
    else if (downstream.has(h.doc_no)) skippedDownstream.push(row);
    else affected.push(row);
  }
  return { affected, skippedMigrated, skippedDownstream };
}

/** "stored -> derived" pair counts, largest first. */
export function pairCounts(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.branding == null ? "(null)" : JSON.stringify(r.branding)} -> ${JSON.stringify(r.derived)}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* The reads restampHeaderBranding makes, for a whole company at once. `sql` is
   a postgres.js client or transaction. Company-scoped except the DO / SI
   lookup, which mirrors soHasDownstream (keyed on so_doc_no alone). */
export async function readHeaderBrandingDrift(sql, company) {
  const cid = Number(company.id);
  const brandRows = await sql`SELECT name FROM project_brands WHERE company_id = ${cid} AND active = 1`;
  const listFallback = { companyCode: company.code ?? null, brands: brandRows.map((b) => String(b.name).trim()).filter(Boolean) };
  const heads = await sql`
    SELECT doc_no, branding, status, linked_ac_docno, project_id, fair_match, so_date::text AS so_date
      FROM scm.mfg_sales_orders
     WHERE company_id = ${cid} AND status IS DISTINCT FROM 'CANCELLED'
     ORDER BY doc_no`;
  const lines = await sql`
    SELECT i.doc_no, i.item_code, i.item_group, i.branding, i.company_id
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${cid}
     WHERE i.company_id = ${cid} AND i.cancelled = false AND h.status IS DISTINCT FROM 'CANCELLED'
     ORDER BY i.doc_no, i.line_no ASC NULLS LAST, i.created_at ASC`;
  const products = await sql`
    SELECT code, branding, category::text AS category FROM scm.mfg_products
     WHERE company_id = ${cid} AND code IN (
       SELECT DISTINCT item_code FROM scm.mfg_sales_order_items WHERE company_id = ${cid} AND cancelled = false AND item_code IS NOT NULL)`;
  const dsRows = await sql`
    SELECT so_doc_no FROM scm.delivery_orders WHERE so_doc_no IS NOT NULL AND status <> 'CANCELLED'
     UNION
    SELECT so_doc_no FROM scm.sales_invoices WHERE so_doc_no IS NOT NULL AND status <> 'CANCELLED'`;
  const downstream = new Set(dsRows.map((r) => r.so_doc_no));
  return { cid, code: company.code, listFallback, ...classifyHeaderBranding({ heads, lines, products, listFallback, downstream }) };
}
