#!/usr/bin/env node
// explore-oct-history2.mjs — READ ONLY. Second look before back-filling the
// change record for 1–19 October 2026: the amendment snapshot's shape, what the
// 'UPDATE' (script) rows and the script / automation line rows touch, how an
// item-code swap is written, and how many orders in the window carry the same
// item code on two lines. Writes nothing. Env: DATABASE_URL.
import postgres from 'postgres';

const WIN = ['2026-09-30T16:00:00Z', '2026-10-20T09:10:46Z'];

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const [rev] = await sql`SELECT r.so_doc_no, r.created_at, r.snapshot FROM scm.so_revisions r JOIN scm.mfg_sales_orders o ON o.doc_no = r.so_doc_no
      WHERE o.company_id = 1 AND r.created_at >= ${WIN[0]} AND r.created_at < ${WIN[1]} ORDER BY r.created_at LIMIT 1`;
    if (rev) {
      const snap = rev.snapshot ?? {};
      console.log(`ROW|snapshot ${rev.so_doc_no} keys: ${Object.keys(snap).join(', ')}`);
      console.log(`ROW|snapshot header keys: ${Object.keys(snap.header ?? {}).join(', ').slice(0, 600)}`);
      const l0 = (snap.lines ?? snap.items ?? [])[0] ?? {};
      console.log(`ROW|snapshot line keys: ${Object.keys(l0).join(', ').slice(0, 600)}`);
      console.log(`ROW|snapshot line[0]: ${JSON.stringify(l0).slice(0, 500)}`);
    }
    const appr = await sql`SELECT a.so_doc_no, a.created_at, a.field_changes, a.note FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no
      WHERE o.company_id = 1 AND a.action = 'AMENDMENT_SO_APPROVED' AND a.created_at >= ${WIN[0]} AND a.created_at < ${WIN[1]} ORDER BY a.created_at LIMIT 2`;
    for (const a of appr) console.log(`ROW|approved ${a.so_doc_no} ${new Date(a.created_at).toISOString()} ${JSON.stringify(a.field_changes).slice(0, 300)} note=${String(a.note ?? '').slice(0, 120)}`);
    const pair = await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE abs(extract(epoch FROM (r.created_at - a.created_at))) <= 5)::int AS near
      FROM scm.so_revisions r JOIN scm.mfg_so_audit_log a ON a.so_doc_no = r.so_doc_no AND a.action = 'AMENDMENT_SO_APPROVED'
      JOIN scm.mfg_sales_orders o ON o.doc_no = r.so_doc_no
      WHERE o.company_id = 1 AND r.created_at >= ${WIN[0]} AND r.created_at < ${WIN[1]}`;
    console.log(`ROW|revision ↔ approval pairs: ${pair[0].n}, within 5s: ${pair[0].near}`);

    const upd = await sql`SELECT f->>'field' AS field, count(*)::int AS n FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no, jsonb_array_elements(a.field_changes) f
      WHERE o.company_id = 1 AND a.action = 'UPDATE' AND a.created_at >= ${WIN[0]} AND a.created_at < ${WIN[1]} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`;
    for (const u of upd) console.log(`ROW|UPDATE(script).${u.field}: ${u.n}`);
    const scr = await sql`SELECT a.source, f->>'field' AS field, count(*)::int AS n FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no, jsonb_array_elements(a.field_changes) f
      WHERE o.company_id = 1 AND a.action = 'UPDATE_LINE' AND a.source NOT IN ('web', 'auto-allocation') AND a.created_at >= ${WIN[0]} AND a.created_at < ${WIN[1]}
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`;
    for (const u of scr) console.log(`ROW|UPDATE_LINE ${u.source}.${u.field}: ${u.n}`);
    const swaps = await sql`SELECT a.so_doc_no, a.created_at, a.field_changes FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no,
        jsonb_array_elements(a.field_changes) f
      WHERE o.company_id = 1 AND a.action = 'UPDATE_LINE' AND a.source = 'web' AND f->>'field' = 'itemCode' AND f ? 'from'
        AND a.created_at >= ${WIN[0]} AND a.created_at < ${WIN[1]} LIMIT 3`;
    for (const s of swaps) console.log(`ROW|code swap ${s.so_doc_no} ${JSON.stringify(s.field_changes).slice(0, 400)}`);
    const prices = await sql`SELECT a.so_doc_no, a.created_at, a.field_changes FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no,
        jsonb_array_elements(a.field_changes) f
      WHERE o.company_id = 1 AND a.action = 'UPDATE_LINE' AND f->>'field' IN ('unitPriceSen', 'qty', 'discountSen')
        AND a.created_at >= ${WIN[0]} AND a.created_at < ${WIN[1]} LIMIT 4`;
    for (const s of prices) console.log(`ROW|price/qty row ${s.so_doc_no} ${new Date(s.created_at).toISOString()} ${JSON.stringify(s.field_changes).slice(0, 400)}`);
    const dup = await sql`WITH touched AS (
        SELECT DISTINCT a.so_doc_no FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no
        WHERE o.company_id = 1 AND a.action IN ('UPDATE_LINE', 'ADD_LINE', 'DELETE_LINE') AND a.source <> 'auto-allocation' AND a.created_at >= ${WIN[0]} AND a.created_at < ${WIN[1]}
      )
      SELECT count(DISTINCT t.so_doc_no)::int AS orders FROM touched t
      JOIN scm.mfg_sales_order_items i ON i.doc_no = t.so_doc_no
      GROUP BY i.doc_no, i.item_code HAVING count(*) > 1`;
    console.log(`ROW|touched orders with a repeated item code (now): ${dup.length}`);
    const [tot] = await sql`SELECT count(DISTINCT a.so_doc_no)::int AS n FROM scm.mfg_so_audit_log a JOIN scm.mfg_sales_orders o ON o.doc_no = a.so_doc_no
      WHERE o.company_id = 1 AND ((a.action IN ('UPDATE_LINE', 'ADD_LINE', 'DELETE_LINE') AND a.source <> 'auto-allocation') OR a.action = 'AMENDMENT_SO_APPROVED')
        AND a.created_at >= ${WIN[0]} AND a.created_at < ${WIN[1]}`;
    console.log(`ROW|orders with line or amendment activity in the window: ${tot.n}`);
    const [hdr] = await sql`SELECT count(*)::int AS n,
        count(*) FILTER (WHERE (o.mattress_sofa_sen + o.bedframe_sen + o.accessories_sen + o.others_sen) <> coalesce((
          SELECT sum(i.total_sen) FROM scm.mfg_sales_order_items i WHERE i.doc_no = o.doc_no AND NOT coalesce(i.cancelled, false)
            AND NOT (upper(coalesce(i.item_code, '')) LIKE 'SVC-%' OR lower(coalesce(i.item_group, '')) LIKE '%service%')), 0))::int AS off
      FROM scm.mfg_sales_orders o WHERE o.company_id = 1 AND o.created_at >= '2026-08-01'`;
    console.log(`ROW|header goods vs lines (orders since Aug): ${hdr.n}, differing ${hdr.off}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
