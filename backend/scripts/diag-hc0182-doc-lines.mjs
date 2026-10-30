#!/usr/bin/env node
// Read-only: where do the KIV bedframe lines of the given orders land under the
// HC-0182 rehome rules (rehome-kiv-bedframe-lines.mjs)? Prints, per line on
// "BEDFRAME KIV LV2", the text it is read from, its order's mattress sizes and
// the target or the reason it stays, with and without the LV2 default.
//
// Strictly SELECTs. Env: DATABASE_URL (required); COMPANY_ID (default 1);
// DOC_NOS (comma list, required; matched as a substring in any company).
import postgres from 'postgres';
import { OLD_CODE, lineText, lineTarget } from './lib/kiv-bedframe-line-target.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const DOC_NOS = String(process.env.DOC_NOS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DOC_NOS.length) { console.error('need DOC_NOS'); process.exit(2); }
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  const rows = await sql.begin('read only', (t) => t`
    SELECT i.company_id, i.doc_no, i.item_code, i.description2, i.remark, i.variants,
           ARRAY(SELECT DISTINCT p.size_code FROM scm.mfg_sales_order_items m
                   JOIN scm.mfg_products p ON p.company_id = m.company_id AND p.code = m.item_code
                  WHERE m.company_id = i.company_id AND m.doc_no = i.doc_no AND coalesce(m.cancelled, false) = false
                    AND p.category::text = 'MATTRESS' AND p.size_code IS NOT NULL) AS mattress_sizes
      FROM scm.mfg_sales_order_items i
     WHERE i.doc_no ILIKE ANY(${DOC_NOS.map((d) => `%${d.replace(/^SO-?/i, '')}%`)}) AND i.item_code ILIKE 'BEDFRAME KIV%'
     ORDER BY i.doc_no, i.id`);
  log(`${rows.length} KIV bedframe line(s) on ${DOC_NOS.length} order(s)`);
  for (const r of rows) {
    const text = lineText(r);
    const a = lineTarget(text, { mattressSizes: r.mattress_sizes });
    const b = lineTarget(text, { mattressSizes: r.mattress_sizes, defaultLevel: '2' });
    log(`  co${r.company_id} ${r.doc_no} ${r.item_code}${r.item_code === OLD_CODE ? '' : ' (not the old code)'} text="${text}" mattress=${JSON.stringify(r.mattress_sizes)} variants=${JSON.stringify(r.variants)}`);
    log(`      default off: ${a.target ?? `stays ${a.stay}`}   LV2 default: ${b.target ?? `stays ${b.stay}`}`);
  }
  await sql.end();
}
main().catch(async (e) => { console.error(e); await sql.end({ timeout: 1 }); process.exit(1); });
