#!/usr/bin/env node
// Fill the SUPPLIER'S stated sofa leg height onto our purchase and sales lines.
// DRY-RUN by default; APPLY=1 needs CONFIRM.
//
// THE ASK (owner, 2026-09-11, handing over the fuller supplier export):
//
//     根据 supplier 的 PO，对回之前的 PO 跟 GR 全部补齐。补齐 PO 的同时，
//     也要补齐 Sales Order，把它的 variant 还有 sofa compartment 全部对齐。
//
// The compartments are done (apply run 34557669854, VERIFY OK). What is left on
// the variant side, measured on production the same day, is the LEG: 68 lines
// across 35 purchase orders carry nothing where the supplier states 1 or 6
// inches. This is the tool for those.
//
// IT IS NOT A BLIND UPDATE, and the reason is docs/bugs/0722. A sofa's leg is
// part of its inventory identity (`computeVariantKey` emits `legheight=` for a
// sofa), so writing one onto a line whose goods are already in moves that line
// to a bucket no lot carries — the exact shape of the defect that shipped three
// delivery orders against nothing. lib/supplier-sofa-leg-plan.mjs holds the gate
// and is unit-tested; this file reads, calls it, writes what it returns, and
// verifies on a FRESH connection.
//
// WHAT IT NEVER DOES
//   · touch a line whose purchase line has received, or has a goods-received or
//     delivery line, or whose sales line has stock allocated — HELD and named;
//   · overwrite a height somebody picked (only a blank, or the `Default`
//     placeholder of docs/bugs/0722, is filled);
//   · touch item codes, quantities, money, or any document whose pieces do not
//     already agree with the supplier line-for-line — where they do not, line i
//     on one side is not line i on the other, so there is nothing to map.
//
// RE-RUN: convergent. A filled line reads the supplier's height on the next run
// and lands in `agreed`, which is not written.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   APPLY=1 + CONFIRM="FILL THE SUPPLIER LEG HEIGHTS"   to write
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parseSofa, pieceSuffix } from './lib/parse-sofa.mjs';
import { planSupplierLegFill } from './lib/supplier-sofa-leg-plan.mjs';

const CONFIRM_PHRASE = 'FILL THE SUPPLIER LEG HEIGHTS';
const WANTS_APPLY = process.env.APPLY === '1';
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
// The refusal lives AT the comparison, its exit adjacent, so a reader — and the
// release-discipline check — can see what guards the write.
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was read or written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;

const gz = (f) => JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', f))).toString('utf8').replace(/^﻿/, ''),
);
const norm = (s) => String(s ?? '').trim().toUpperCase();
const modelOf = (code) => { const s = norm(code); const i = s.indexOf('-'); return i < 0 ? s : s.slice(0, i); };
const bag = (xs) => xs.slice().sort().join('|');
/* A run listed from the other end is the SAME sofa — the checker's rule, and the
   owner's (「这两个一样啊」, 2026-09-10). Here it decides only whether line i
   maps to line i; a REVERSED document maps in reverse. */
const sameSofa = (a, b) => a.join('+') === b.join('+') || a.slice().reverse().join('+') === b.join('+');

const book = gz('supplier-so-detail-2026-09-11.json.gz');
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

async function findPo(ref) {
  if (!ref) return null;
  const byLinked = async (v) => (await sql`
    SELECT id, po_number FROM scm.purchase_orders
     WHERE company_id = ${CO} AND linked_ac_docno = ${v}`)[0] ?? null;
  const byNumber = async (v) => (await sql`
    SELECT id, po_number FROM scm.purchase_orders
     WHERE company_id = ${CO} AND po_number = ${v}`)[0] ?? null;
  return (await byLinked(ref))
    ?? (await byNumber(ref))
    /* The Customer PO column sometimes drops our company prefix: `PO-2609-051`
       is our `HC-PO-2609-051`. Only for the OUR-doc shape, so it can never
       invent a match for an AutoCount number we do not hold. */
    ?? (/^PO-\d{4}-\d+$/.test(ref) ? await byNumber(`HC-${ref}`) : null);
}

try {
  line('='.repeat(78));
  line('SUPPLIER SOFA LEG HEIGHT — fill our blanks from the supplier own build record');
  line('='.repeat(78));
  line(`   source: ${book._source}`);
  line(`   sha256 of the workbook: ${book._sha256}`);
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const docs = [];
  const skipped = [];
  const withSofa = book.documents.filter((d) => d.lines.some((l) => norm(l.group) === 'SOFA'));
  for (const d of withSofa) {
    const lines = d.lines.filter((l) => norm(l.group) === 'SOFA');
    const po = await findPo(d.ourPoRef);
    if (!po) { skipped.push(`${d.ourPoRef || '(no ref)'}: no purchase order of ours`); continue; }

    const ours = await sql`
      SELECT i.id, i.item_code, i.variants, i.so_item_id, i.received_qty
        FROM scm.purchase_order_items i
       WHERE i.purchase_order_id = ${po.id} AND upper(coalesce(i.item_group, '')) = 'SOFA'
       ORDER BY i.id`;
    if (!ours.length) { skipped.push(`${po.po_number}: no sofa line`); continue; }

    /* Expanded by quantity — the supplier bills two single seats as two rows,
       we may hold one row of qty 2 (HC-PO-009989). Pieces are compared expanded;
       the line-for-line mapping below then needs the ROWS to line up too. */
    const expand = (piece, qty) => Array.from({ length: Math.max(1, Math.round(Number(qty) || 1)) }, () => piece);
    const theirs = lines.flatMap((l) => expand(pieceSuffix(l.code), l.qty));
    const mine = ours.flatMap((r) => expand(pieceSuffix(r.item_code), r.qty));
    if (lines.length !== ours.length) {
      skipped.push(`${po.po_number}: ${lines.length} supplier row(s) against ${ours.length} of ours — a quantity-collapsed row has no line to pair with`);
      continue;
    }
    if (bag(theirs) !== bag(mine)) {
      skipped.push(`${po.po_number}: pieces differ — supplier ${theirs.join('+')} vs ours ${mine.join('+')}`);
      continue;
    }
    if (!sameSofa(theirs, mine)) {
      skipped.push(`${po.po_number}: same pieces in a different ORDER — line-for-line mapping is not safe`);
      continue;
    }
    /* Listed from the other end: map in reverse so line i is still the same
       piece on both sides. */
    const theirLines = theirs.join('+') === mine.join('+') ? lines : lines.slice().reverse();

    const pairs = [];
    for (let i = 0; i < ours.length; i += 1) {
      const r = ours[i];
      const want = parseSofa(theirLines[i].desc2 || '', modelOf(theirLines[i].code));
      const [{ n: grnLines }] = await sql`
        SELECT count(*)::int AS n FROM scm.grn_items WHERE purchase_order_item_id = ${r.id}`;
      let so = null;
      let doLines = 0;
      if (r.so_item_id) {
        [so] = await sql`SELECT id, doc_no, variants, stock_qty_ready, allocated_batch_no
                           FROM scm.mfg_sales_order_items WHERE id = ${r.so_item_id}`;
        [{ n: doLines }] = await sql`
          SELECT count(*)::int AS n FROM scm.delivery_order_items WHERE so_item_id = ${r.so_item_id}`;
      }
      pairs.push({
        poItemId: r.id,
        soItemId: so?.id ?? null,
        soDocNo: so?.doc_no ?? null,
        itemCode: r.item_code,
        supplierLeg: want.leg ?? null,
        poLeg: (r.variants || {}).legHeight ?? null,
        soLeg: so ? ((so.variants || {}).legHeight ?? null) : null,
        receivedQty: Number(r.received_qty ?? 0),
        grnLines: Number(grnLines),
        doLines: Number(doLines),
        soReadyQty: Number(so?.stock_qty_ready ?? 0),
        soAllocatedBatch: so?.allocated_batch_no ?? null,
      });
    }
    docs.push({ poNumber: po.po_number, supplierDoc: d.supplierDoc, ourPoRef: d.ourPoRef, pairs });
  }

  const { writes, holds, agreed } = planSupplierLegFill(docs);

  rule();
  line(`   supplier documents with a sofa            ${withSofa.length}`);
  line(`   comparable (our PO found, pieces agree)   ${docs.length}`);
  line(`   not comparable                            ${skipped.length}`);
  line(`   lines already carrying the supplier leg   ${agreed}`);
  line(`   lines TO FILL                             ${writes.length}   over ${new Set(writes.map((w) => w.poNumber)).size} purchase order(s)`);
  line(`   lines HELD                                ${holds.length}   over ${new Set(holds.map((h) => h.poNumber)).size} purchase order(s)`);
  rule();
  for (const w of writes) {
    const salesSide = w.soItemId ? w.soDocNo : (w.soDocNo ? 'already set' : 'not linked');
    line(`   FILL  ${w.poNumber.padEnd(16)} ${w.itemCode.padEnd(16)} leg ${w.legHeight}`
      + `   purchase line ${w.poItemId ? 'yes' : 'already set'} · sales line ${salesSide}`);
  }
  rule();
  for (const h of holds) line(`   HELD  ${h.poNumber.padEnd(16)} ${h.itemCode.padEnd(16)} ${h.why}`);
  rule();
  for (const s of skipped.slice(0, 12)) line(`   skip  ${s}`);
  if (skipped.length > 12) line(`   ... and ${skipped.length - 12} more not comparable`);

  if (!APPLY) {
    rule();
    line('DRY-RUN — nothing was written.');
    line(`To write: APPLY=1 CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    rule();
    let poWritten = 0;
    let soWritten = 0;
    /* Per purchase order, so a failure on one cannot half-fill another. */
    const byPo = new Map();
    for (const w of writes) {
      if (!byPo.has(w.poNumber)) byPo.set(w.poNumber, []);
      byPo.get(w.poNumber).push(w);
    }
    for (const [poNumber, group] of byPo) {
      await sql.begin(async (t) => {
        for (const w of group) {
          if (w.poItemId) {
            await t`UPDATE scm.purchase_order_items
                       SET variants = coalesce(variants, '{}'::jsonb) || jsonb_build_object('legHeight', ${w.legHeight}::text)
                     WHERE id = ${w.poItemId}`;
            poWritten += 1;
          }
          if (w.soItemId) {
            await t`UPDATE scm.mfg_sales_order_items
                       SET variants = coalesce(variants, '{}'::jsonb) || jsonb_build_object('legHeight', ${w.legHeight}::text)
                     WHERE id = ${w.soItemId}`;
            soWritten += 1;
          }
        }
      });
      line(`   written  ${poNumber}  ${group.length} line(s)`);
    }
    line(`APPLIED — ${poWritten} purchase line(s), ${soWritten} sales line(s).`);

    /* VERIFY on a FRESH connection: the session that wrote is the worst witness
       that the write landed. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const ids = writes.map((w) => w.poItemId).filter(Boolean);
      const soIds = writes.map((w) => w.soItemId).filter(Boolean);
      const bad = ids.length
        ? await check`SELECT id, item_code, coalesce(variants->>'legHeight', '') AS leg
                        FROM scm.purchase_order_items WHERE id = ANY(${ids})
                         AND coalesce(variants->>'legHeight', '') = ''`
        : [];
      const badSo = soIds.length
        ? await check`SELECT id, item_code, coalesce(variants->>'legHeight', '') AS leg
                        FROM scm.mfg_sales_order_items WHERE id = ANY(${soIds})
                         AND coalesce(variants->>'legHeight', '') = ''`
        : [];
      if (bad.length || badSo.length) {
        line(`VERIFY FAILED — ${bad.length} purchase and ${badSo.length} sales line(s) still blank.`);
        process.exitCode = 1;
      } else {
        line(`VERIFY OK — ${ids.length} purchase and ${soIds.length} sales line(s) now carry the supplier leg height.`);
      }
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
