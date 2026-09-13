#!/usr/bin/env node
// READ-ONLY. SELECT only, no DDL, no writes, no transaction.
//
// WHY: a printed 2990 sales order (doc_no on the page, line items underneath)
// can disagree with the live row. Two explanations produce the same symptom and
// only one observation separates them:
//   AMENDED  — the doc_no is right and the order's LINES changed after printing.
//   MISPRINT — the doc_no on the page belongs to a different order entirely.
// The separator is WHO the order is for, plus whether an amendment exists.
//
// PUBLIC REPO — workflow logs are public. Customer identity is NEVER printed:
// customer_id / customer_name / debtor_code are reported as a 12-hex sha256
// prefix, which compares for EQUALITY across docs and reveals nothing.
//
//   DOCS=2990-SO-2607-019,2990-SO-2606-040 COMPANY=2 node scripts/probe-so-identity-and-amendments.mjs
import postgres from 'postgres';
import { createHash } from 'node:crypto';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const DOCS = (process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DOCS.length) { console.error('need DOCS=doc_no[,doc_no...]'); process.exit(2); }
const CO = Number((process.env.COMPANY || '2').trim());

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (c) => (c == null ? '(null)' : 'RM' + (Number(c) / 100).toFixed(2));
const idh = (v) => (v == null || v === '' ? '(null)' : createHash('sha256').update(String(v)).digest('hex').slice(0, 12));

async function cols(schema, table) {
  const r = await sql`SELECT column_name FROM information_schema.columns
                       WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}

async function main() {
  const hc = await cols('scm', 'mfg_sales_orders');
  const idCols = ['customer_id', 'customer_name', 'debtor_code'].filter((c) => hc.has(c));
  const stampCols = ['created_at', 'updated_at'].filter((c) => hc.has(c));
  const sel = ['doc_no', 'status', 'local_total_sen', 'customer_delivery_date', ...idCols, ...stampCols]
    .filter((c) => c === 'doc_no' || hc.has(c));
  note(`identity columns present on scm.mfg_sales_orders: ${idCols.join(', ') || '(none)'}`);
  note(`identity is printed as sha256[0:12] — equal hash = same value, and the value itself is not disclosed.\n`);

  const fp = {};
  for (const doc of DOCS) {
    const rows = await sql.unsafe(
      `SELECT ${sel.map((c) => `"${c}"`).join(', ')} FROM scm.mfg_sales_orders
        WHERE company_id = ${CO} AND doc_no = '${doc.replace(/'/g, "''")}'`);
    note(`=== ${doc}  (company ${CO}) — ${rows.length} header row(s)`);
    if (!rows.length) { note('    NOT PRESENT\n'); continue; }
    const h = rows[0];
    note(`    status=${h.status}  total=${rm(h.local_total_sen)}  customer_delivery_date=${h.customer_delivery_date ?? '(null)'}`);
    for (const c of stampCols) note(`    ${c}=${h[c] ?? '(null)'}`);
    const idParts = idCols.map((c) => `${c}#${idh(h[c])}`);
    note(`    IDENTITY  ${idParts.join('  ')}`);
    fp[doc] = idParts.join('|');

    const lines = await sql.unsafe(
      `SELECT item_code, qty, unit_price_sen, discount_sen, line_total_sen, cancelled, created_at
         FROM scm.mfg_sales_order_items
        WHERE company_id = ${CO} AND doc_no = '${doc.replace(/'/g, "''")}'
        ORDER BY line_no NULLS LAST, created_at`);
    note(`    ${lines.length} line(s) LIVE NOW:`);
    for (const l of lines) {
      note(`      ${String(l.item_code ?? '').padEnd(24)} qty=${l.qty}  unit=${rm(l.unit_price_sen)}  disc=${rm(l.discount_sen)}  total=${rm(l.line_total_sen)}  cancelled=${l.cancelled}  created=${l.created_at ?? '(null)'}`);
    }

    const am = await sql.unsafe(
      `SELECT id::text AS id, status::text AS status, lane, created_at, updated_at
         FROM scm.so_amendments WHERE so_doc_no = '${doc.replace(/'/g, "''")}' ORDER BY created_at`);
    note(`    ${am.length} amendment(s):`);
    for (const a of am) {
      note(`      amendment ${a.id.slice(0, 8)}  status=${a.status}  lane=${a.lane ?? '(legacy)'}  created=${a.created_at}  updated=${a.updated_at ?? '(null)'}`);
      const al = await sql.unsafe(
        `SELECT * FROM scm.so_amendment_lines WHERE amendment_id = '${a.id}' ORDER BY created_at`);
      for (const l of al) {
        const money = Object.keys(l).filter((k) => /price|total|sen|qty|item_code|action|op/.test(k))
          .map((k) => `${k}=${l[k]}`).join(' ');
        note(`        line: ${money}`);
      }
    }
    note('');
  }

  const keys = Object.keys(fp);
  if (keys.length > 1) {
    note('=== IDENTITY COMPARISON (the observation that separates AMENDED from MISPRINT)');
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        note(`    ${keys[i]}  vs  ${keys[j]}  ->  SAME CUSTOMER: ${fp[keys[i]] === fp[keys[j]]}`);
      }
    }
  }
}

main().then(() => sql.end()).catch((e) => { console.error(e); sql.end(); process.exit(1); });
