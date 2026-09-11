#!/usr/bin/env node
/* probe-lounger-read-as-arm - find the sales order the owner is looking at (a
 * build whose END piece is a LOUNGER drawn as a taller box, but recorded as an
 * ARM 1A), show its full state, and cross-check its PO reference against the
 * SUPPLIER export. READ-ONLY. SELECTs only, no writes, no DDL, no transaction.
 *
 * WHY: the owner, 2026-09-11, with the screen and the drawing in front of him -
 * three 35" boxes, the third TALLER and hatched on the right, which is a lounger
 * L(RHF); the ERP holds 8030-1A(LHF)+8030-1NA+8030-1A(RHF) and the GR will not
 * match. He says the SUPPLIER also has it as 1A+1NA+1L. This finds the document,
 * says whether it is in the supplier export at all (if not, that is why the
 * supplier round never touched it), and lists every OTHER build whose end piece
 * is 1A where the supplier holds an L - the same error class.
 *
 * NEEDLE   optional text to find the doc (default: distinctive specials on the
 *          owner's screen). DOC overrides with an explicit doc number.
 * DATABASE_URL required.  COMPANY_ID default 1.
 *
 * RE-RUN: read-only and stateless.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const DOC = (process.env.DOC || '').trim();
const NEEDLE = (process.env.NEEDLE || 'Seat Base Fully Cover with no Leg').trim();
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (s = '') => console.log(`::notice::${s}`);
const suffix = (c) => { const s = String(c ?? '').toUpperCase(); const i = s.indexOf('-'); return i < 0 ? s : s.slice(i + 1); };

const book = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', 'supplier-so-detail-2026-09-11.json.gz')))
    .toString('utf8').replace(/^﻿/, ''),
);
/* index supplier docs by our PO ref */
const byRef = new Map();
for (const d of book.documents) byRef.set(String(d.ourPoRef), d);

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`company ${CO}. ${DOC ? `doc = ${DOC}` : `needle = "${NEEDLE}"`}`);

  /* 1. find the target sales-order document(s) */
  const docRows = DOC
    ? await sql`SELECT DISTINCT doc_no FROM scm.mfg_sales_order_items
                 WHERE company_id = ${CO} AND doc_no = ${DOC}`
    : await sql`SELECT DISTINCT doc_no FROM scm.mfg_sales_order_items
                 WHERE company_id = ${CO}
                   AND (coalesce(description,'') ILIKE ${'%' + NEEDLE + '%'}
                        OR coalesce(description2,'') ILIKE ${'%' + NEEDLE + '%'})`;
  const docs = [...new Set(docRows.map((r) => r.doc_no))];
  log(`matched ${docs.length} document(s): ${docs.join(', ') || '(none)'}`);

  for (const doc of docs) {
    log('');
    log(`================ ${doc} ================`);
    const items = await sql`
      SELECT i.id, i.line_no, i.item_code, i.item_group, coalesce(i.qty,0) AS qty,
             i.linked_ac_dtlkey::text AS dtlkey,
             coalesce(i.description2,'') AS d2, coalesce(i.cancelled,false) AS cancelled,
             i.variants
        FROM scm.mfg_sales_order_items i
       WHERE i.company_id = ${CO} AND i.doc_no = ${doc}
       ORDER BY i.line_no, i.id`;
    for (const it of items) {
      const leg = (it.variants ?? {}).legHeight ?? '';
      log(`  L${it.line_no}  id=${it.id} ${String(it.item_code).padEnd(16)} grp=${it.item_group||''} qty=${it.qty} leg="${leg}" key=${it.dtlkey||'-'}${it.cancelled?' [CANCELLED]':''}`);
    }
    const sofa = items.filter((i) => String(i.item_group||'').toLowerCase() === 'sofa' && !i.cancelled);
    log(`  OUR sofa pieces: ${sofa.map((i) => suffix(i.item_code)).join('+') || '(none)'}`);

    /* the PO raised from it */
    const po = await sql`
      SELECT DISTINCT p.id, p.po_number, p.linked_ac_docno
        FROM scm.purchase_orders p
        JOIN scm.purchase_order_items pi ON pi.purchase_order_id = p.id
        JOIN scm.mfg_sales_order_items si ON si.id = pi.so_item_id
       WHERE si.doc_no = ${doc} AND p.company_id = ${CO}
       LIMIT 1`;
    if (po[0]) {
      const prows = await sql`
        SELECT pi.id, pi.item_code, coalesce(pi.received_qty,0) AS received,
               pi.linked_ac_dtlkey::text AS dtlkey
          FROM scm.purchase_order_items pi
         WHERE pi.purchase_order_id = ${po[0].id}
           AND lower(coalesce(pi.item_group,''))='sofa'
         ORDER BY pi.id`;
      const poRecd = prows.reduce((a, r) => a + Number(r.received || 0), 0);
      log(`  PO: ${po[0].po_number}  linked_ac_docno=${po[0].linked_ac_docno||'-'}  received=${poRecd}`);
      for (const r of prows) log(`      PO line id=${r.id} ${String(r.item_code).padEnd(16)} recd=${r.received} key=${r.dtlkey||'-'}`);
      /* does the target lounger SKU exist to change into? */
      const model = prows[0] ? String(prows[0].item_code).split('-')[0] : '';
      const wantL = await sql`
        SELECT code FROM scm.mfg_products
         WHERE company_id = ${CO} AND code ILIKE ${model + '-L(%'}`;
      log(`      lounger SKUs for ${model}: ${wantL.map((r) => r.code).join(', ') || 'NONE MINTED'}`);
      for (const ref of [po[0].linked_ac_docno, po[0].po_number]) {
        if (ref && byRef.has(String(ref))) {
          const sd = byRef.get(String(ref));
          const sp = sd.lines.filter((l) => String(l.group).toUpperCase()==='SOFA').map((l) => suffix(l.code));
          log(`  >>> SUPPLIER export HAS ${ref} (${sd.supplierDoc}): pieces ${sp.join('+')}`);
        } else if (ref) {
          log(`  >>> SUPPLIER export does NOT carry ${ref} — this doc was never in the supplier round`);
        }
      }
    } else {
      log('  PO: none linked');
    }
  }

  /* 2. the ERROR CLASS: every proceeded sofa build whose END piece is an ARM
        while the supplier's matching document ends in a LOUNGER L. */
  log('');
  log('================ ERROR CLASS: end piece is 1A here, L at the supplier ================');
  let n = 0;
  for (const [ref, sd] of byRef) {
    const sp = sd.lines.filter((l) => String(l.group).toUpperCase()==='SOFA').map((l) => suffix(l.code));
    if (!sp.length) continue;
    const supplierHasL = sp.some((p) => /^L\(/.test(p) || p === 'L');
    if (!supplierHasL) continue;
    const po = (await sql`SELECT id, po_number FROM scm.purchase_orders
                           WHERE company_id=${CO} AND linked_ac_docno=${ref}`)[0]
      ?? (await sql`SELECT id, po_number FROM scm.purchase_orders
                     WHERE company_id=${CO} AND po_number=${ref}`)[0];
    if (!po) continue;
    const rows = await sql`SELECT upper(split_part(item_code,'-',2)) AS s
                             FROM scm.purchase_order_items
                            WHERE purchase_order_id=${po.id}
                              AND lower(coalesce(item_group,''))='sofa'
                              AND coalesce(cancelled,false)=false
                            ORDER BY id`;
    const mine = rows.map((r) => r.s);
    if (!mine.length) continue;
    const mineHasL = mine.some((p) => /^L\(/.test(p) || p === 'L');
    if (!mineHasL && mine.some((p) => /1A\(/.test(p))) {
      n += 1;
      log(`  ${po.po_number} (${ref})  ours ${mine.join('+')}  vs supplier ${sp.join('+')}`);
    }
  }
  log(`  ${n} build(s) where the supplier has a lounger and we recorded only arms`);
} finally {
  await sql.end({ timeout: 5 });
}
