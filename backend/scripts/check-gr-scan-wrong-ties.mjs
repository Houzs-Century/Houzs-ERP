// Read-only: lines of scanned delivery orders, read since SINCE, whose tied PO
// line names a different model or size than the row printed. Counts and codes
// only (item codes, PO and GRN numbers; no prices or customers).
//
// WHY: 2026-11-13 #5717 put our SO number into every Hookka row, which let the
// "pieces of that SO" fallback tie a CODY 1007-(Q) row to a CELENE 2038 line.
// This lists any such tie on scans read since, created or not.
//
// RE-RUN: Actions -> "Run a backend script on production" -> check-gr-scan-wrong-ties.mjs,
//   mode plan. Env: SINCE=2026-11-13T14:00:00Z. Writes nothing anywhere.
import postgres from 'postgres';

const SINCE = process.env.SINCE || '2026-11-13T14:00:00Z';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const models = (s) => new Set([...(s ?? '').matchAll(/(\d{4,})/g)].map((m) => m[1]));
const suffix = (s) => /\(([A-Z]{1,3})\)\s*$/i.exec((s ?? '').trim())?.[1]?.toUpperCase() ?? null;

try {
  const rows = await sql`
    SELECT j.id, j.review_state, to_char(j.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'MM-DD HH24:MI') AS at,
           j.review->>'doNo' AS do_no, e->'read'->>'itemCode' AS printed, e->>'poItemId' AS po_item_id,
           pi.item_code, pi.supplier_sku, po.po_number
      FROM scm.scan_jobs j
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(j.review->'lines', '[]'::jsonb)) e
      LEFT JOIN scm.purchase_order_items pi ON pi.id::text = e->>'poItemId'
      LEFT JOIN scm.purchase_orders po ON po.id = pi.po_id
     WHERE j.document_type = 'GR' AND j.created_at >= ${SINCE}
       AND e->>'poItemId' IS NOT NULL AND e->'read'->>'itemCode' IS NOT NULL
     ORDER BY j.created_at`;
  let bad = 0;
  for (const r of rows) {
    const pm = models(r.printed);
    const ours = `${r.item_code ?? ''} ${r.supplier_sku ?? ''}`;
    const om = models(ours);
    const modelOff = pm.size > 0 && om.size > 0 && ![...pm].some((m) => om.has(m));
    const ps = suffix(r.printed);
    const sizeOff = ps !== null && ![r.item_code, r.supplier_sku].some((c) => suffix(c) === ps);
    if (!modelOff && !sizeOff) continue;
    bad += 1;
    console.log(`${r.at} | ${r.review_state} | ${r.do_no} | printed ${r.printed} -> ${r.po_number} ${r.supplier_sku ?? r.item_code} | ${modelOff ? 'model' : 'size'}`);
  }
  console.log(`tied lines checked: ${rows.length}; model or size differs: ${bad}`);
  const made = await sql`
    SELECT g.grn_number, g.status, g.created_at
      FROM scm.goods_receipts g
     WHERE g.created_at >= ${SINCE} AND g.notes ILIKE '%scan%'
     ORDER BY g.created_at`.catch((e) => { console.log(`(receipt list skipped: ${e.message.slice(0, 80)})`); return []; });
  for (const g of made) console.log(`receipt since: ${g.grn_number} ${g.status} ${g.created_at.toISOString()}`);
} finally {
  await sql.end();
}
