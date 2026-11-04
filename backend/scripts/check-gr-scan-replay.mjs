// Read-only: replay every delivery order the scanner has ever read through today's
// matcher, and report by supplier how many rows tie to a PO line, so a change to
// matching is measured on real paper without anyone scanning again (owner
// 2026-11-04: the scans were already done).
//
// A past delivery order's PO is usually fully received by now, so each PO line
// counts as owing its whole qty: this measures whether a row FINDS its line, not
// whether the line still has room. No OCR runs; it reads the stored extraction.
//
// SELECT only. Exit 0 for every answer; only a failed query exits non-zero.
// Env: DATABASE_URL (required); COMPANY_ID (optional); LIST_LIMIT (default 8).
import postgres from 'postgres';
import { buildReview } from '../src/scm/lib/grn-scan-check.ts';
import { matchGrnScanToPoLines, resolveScannedSupplier } from '../src/scm/lib/grn-scan-match.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const ONLY = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;
const LIST_LIMIT = Number(process.env.LIST_LIMIT) > 0 ? Number(process.env.LIST_LIMIT) : 8;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  const reads = await sql`
    SELECT DISTINCT ON (s.id) j.company_id, j.created_at, j.file_name, s.extracted
    FROM scm.so_scan_samples s
    JOIN scm.scan_jobs j ON j.sample_id = s.id
    WHERE s.document_type = 'GR' AND s.extracted IS NOT NULL
    ORDER BY s.id, j.created_at DESC`;
  const companies = [...new Set(reads.map((r) => Number(r.company_id)))].filter((c) => ONLY == null || c === ONLY).sort();
  console.log(`Stored delivery order reads: ${reads.length}, companies ${companies.join(', ')}`);

  for (const co of companies) {
    const suppliers = (await sql`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${co}`).map((r) => ({ id: r.id, code: r.code, name: r.name }));
    const lines = await sql`
      SELECT i.id, i.purchase_order_id, i.item_code, i.material_name, i.supplier_sku, i.qty, i.item_group, i.description2,
             p.po_number, p.supplier_id, so.doc_no AS so_doc_no
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items so ON so.id = i.so_item_id
      WHERE p.company_id = ${co} AND p.status NOT IN ('CANCELLED', 'DRAFT')`;
    const open = lines.map((r) => ({
      poItemId: r.id, poId: r.purchase_order_id, poNumber: r.po_number, supplierId: r.supplier_id, itemCode: r.item_code ?? '',
      materialName: r.material_name, supplierSku: r.supplier_sku, remaining: Number(r.qty) || 0, locationCode: null,
      description2: r.description2, soDocNo: r.so_doc_no, itemGroup: r.item_group,
    }));
    const bindings = (await sql`SELECT supplier_sku, ac_item_code, item_code FROM scm.supplier_material_bindings WHERE company_id = ${co}`)
      .filter((b) => b.item_code).map((b) => ({ supplierSku: b.supplier_sku, acItemCode: b.ac_item_code, itemCode: b.item_code }));

    const bySupplier = new Map();
    for (const r of reads.filter((x) => Number(x.company_id) === co)) {
      const parsed = typeof r.extracted === 'string' ? JSON.parse(r.extracted) : r.extracted;
      if (!Array.isArray(parsed?.lines)) continue;
      const supplierId = resolveScannedSupplier(parsed.supplierName ?? null, suppliers);
      const name = suppliers.find((s) => s.id === supplierId)?.name ?? `(not one of ours) ${parsed.supplierName ?? ''}`;
      const match = matchGrnScanToPoLines(parsed.poNo ?? null, parsed.lines.map((l) => ({ ...l, poNo: l.poNo ?? null, rack: l.rack ?? null })), open, bindings, supplierId);
      const review = buildReview(parsed, supplierId, match, [], open.filter((l) => l.supplierId === supplierId));
      const rows = review.lines.length;
      const tied = review.lines.filter((l) => l.poItemId).length;
      const g = bySupplier.get(name) ?? { docs: 0, full: 0, rows: 0, tied: 0, misses: [] };
      g.docs += 1; g.rows += rows; g.tied += tied;
      if (rows > 0 && tied === rows) g.full += 1;
      else if (g.misses.length < LIST_LIMIT) {
        const miss = review.lines.find((l) => !l.poItemId);
        g.misses.push(`${parsed.doNo ?? r.file_name ?? '?'}: PO read ${parsed.poNo ?? '-'}; ${[miss?.read?.itemCode, miss?.read?.description].filter(Boolean).join(' / ').slice(0, 90)}`);
      }
      bySupplier.set(name, g);
    }

    console.log(`\n===== Company ${co}: PO lines ${open.length}, bindings ${bindings.length} =====`);
    for (const [name, g] of [...bySupplier].sort((a, b) => b[1].docs - a[1].docs)) {
      console.log(`${name}: ${g.full}/${g.docs} documents fully tied, ${g.tied}/${g.rows} rows`);
      for (const m of g.misses) console.log(`    ${m}`);
    }
  }
}

main().then(() => sql.end()).catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
