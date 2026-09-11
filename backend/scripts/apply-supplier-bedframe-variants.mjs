#!/usr/bin/env node
// Write the SUPPLIER'S stated divan / gap / leg onto our bedframe lines — the
// purchase line and its sales line together. DRY-RUN by default; APPLY=1 needs
// CONFIRM.
//
// THE ASK (owner, 2026-09-11): 「跟着供应商，供应商那边写的东西肯定是对的…
// 无论是 BedFrame 还是 sofa compartment 跟它们的 variant」. Measured read-only the
// same day: of 830 supplier documents carrying a bedframe, 305 have a purchase
// order here; 284 agree, 3 differ on SIZE (a code change — not this tool) and
// **18 differ on div / gap / leg**, some blank on our side and some stating a
// different number.
//
// THE GATE IS docs/bugs/0722, exactly as in apply-supplier-sofa-leg.mjs. All
// three axes compose a bedframe's inventory identity (`computeVariantKey`), so a
// line whose goods are already in stays where it is and is reported.
//
// MATCHED BY SIZE, NOT BY ROW. A bedframe line is a whole bed and the order of
// three beds on one document carries no meaning — the same rule
// check-supplier-bedframe-vs-erp.mjs states and applies. Where one size appears
// twice on a document the rows are taken in order within that size, and where
// the two carry DIFFERENT measurements the document is skipped: telling two
// same-size beds apart is exactly what the export cannot do.
//
// RE-RUN: convergent. A written line reads the supplier's numbers on the next
// run and lands in `agreed`, which is not written.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   APPLY=1 + CONFIRM="FILL THE SUPPLIER BEDFRAME MEASUREMENTS"   to write
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { BED_AXES, inches, planBedframeVariantFill } from './lib/supplier-bedframe-variant-plan.mjs';

const CONFIRM_PHRASE = 'FILL THE SUPPLIER BEDFRAME MEASUREMENTS';
const WANTS_APPLY = process.env.APPLY === '1';
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
// The refusal lives AT the comparison, its exit adjacent.
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was read or written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;

const gz = (f) => JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', f))).toString('utf8').replace(/^﻿/, ''),
);
const norm = (s) => String(s ?? '').trim().toUpperCase();
/* `1007-(K)` -> `(K)`, `2038(A)-(SS)` -> `(SS)`. The LAST dash, because a model
   may itself contain one — the bedframe checker's reader. */
const sizeOf = (code) => { const s = norm(code); const i = s.lastIndexOf('-'); return i < 0 ? s : s.slice(i + 1); };
const bag = (xs) => xs.slice().sort().join('|');
/* div / gap / leg in inches, only what the string STATES. */
const bedVariants = (d2) => {
  const out = {};
  const s = String(d2 ?? '').toLowerCase();
  for (const key of ['div', 'gap', 'leg']) {
    const m = new RegExp(`\\b${key}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(s);
    if (m) out[key] = m[1];
  }
  return out;
};

/* Self-test the readers before anything is reported: a matcher that cannot match
   must never read as "nothing to do". */
{
  const v = bedVariants('div:8inch / leg:1inch / gap:16inch');
  const ok = v.div === '8' && v.leg === '1' && v.gap === '16'
    && sizeOf('2038(A)-(SS)') === '(SS)' && sizeOf('1007-(K)') === '(K)'
    && inches('10"') === '10' && inches(null) === null;
  if (!ok) { console.error('SELF-TEST FAILED on the bedframe readers. Refusing to run.'); process.exit(1); }
}

const book = gz('supplier-so-detail-2026-09-11.json.gz');
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

async function findPo(ref) {
  if (!ref) return null;
  const byLinked = async (v) => (await sql`SELECT id, po_number FROM scm.purchase_orders
                                            WHERE company_id = ${CO} AND linked_ac_docno = ${v}`)[0] ?? null;
  const byNumber = async (v) => (await sql`SELECT id, po_number FROM scm.purchase_orders
                                            WHERE company_id = ${CO} AND po_number = ${v}`)[0] ?? null;
  return (await byLinked(ref))
    ?? (await byNumber(ref))
    ?? (/^PO-\d{4}-\d+$/.test(ref) ? await byNumber(`HC-${ref}`) : null);
}

try {
  line('='.repeat(78));
  line('SUPPLIER BEDFRAME MEASUREMENTS — divan / gap / leg, from the supplier own record');
  line('='.repeat(78));
  line(`   source: ${book._source}`);
  line(`   sha256 of the workbook: ${book._sha256}`);
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const withBed = book.documents.filter((d) => d.lines.some((l) => norm(l.group) === 'BEDFRAME'));
  const docs = [];
  const skipped = [];
  for (const d of withBed) {
    const lines = d.lines.filter((l) => norm(l.group) === 'BEDFRAME');
    const po = await findPo(d.ourPoRef);
    if (!po) { skipped.push(`${d.ourPoRef || '(no ref)'}: no purchase order of ours`); continue; }

    const ours = await sql`
      SELECT i.id, i.item_code, i.variants, i.so_item_id, i.received_qty
        FROM scm.purchase_order_items i
       WHERE i.purchase_order_id = ${po.id} AND upper(coalesce(i.item_group, '')) = 'BEDFRAME'
       ORDER BY i.id`;
    if (!ours.length) { skipped.push(`${po.po_number}: no bedframe line`); continue; }

    if (bag(lines.map((l) => sizeOf(l.code))) !== bag(ours.map((r) => sizeOf(r.item_code)))) {
      skipped.push(`${po.po_number}: sizes differ — supplier ${lines.map((l) => sizeOf(l.code)).join('+')} vs ours ${ours.map((r) => sizeOf(r.item_code)).join('+')}`);
      continue;
    }

    /* Pool by size. Two beds of the SAME size stating DIFFERENT measurements
       cannot be told apart by anything in this file, so the document is skipped
       rather than paired arbitrarily. */
    const bySize = new Map();
    for (const r of ours) {
      const k = sizeOf(r.item_code);
      if (!bySize.has(k)) bySize.set(k, []);
      bySize.get(k).push(r);
    }
    const stated = new Map();
    let ambiguous = null;
    for (const l of lines) {
      const k = sizeOf(l.code);
      const v = JSON.stringify(bedVariants(l.desc2));
      if (stated.has(k) && stated.get(k) !== v) ambiguous = k;
      stated.set(k, v);
    }
    if (ambiguous) {
      skipped.push(`${po.po_number}: two ${ambiguous} beds state different measurements — nothing in the export says which bed is which`);
      continue;
    }

    const pairs = [];
    for (const l of lines) {
      const pool = bySize.get(sizeOf(l.code));
      if (!pool || !pool.length) continue;
      const r = pool.shift();
      const [{ n: grnLines }] = await sql`SELECT count(*)::int AS n FROM scm.grn_items WHERE purchase_order_item_id = ${r.id}`;
      let so = null;
      let doLines = 0;
      if (r.so_item_id) {
        [so] = await sql`SELECT id, doc_no, variants, stock_qty_ready, allocated_batch_no
                           FROM scm.mfg_sales_order_items WHERE id = ${r.so_item_id}`;
        [{ n: doLines }] = await sql`SELECT count(*)::int AS n FROM scm.delivery_order_items WHERE so_item_id = ${r.so_item_id}`;
      }
      pairs.push({
        poItemId: r.id,
        soItemId: so?.id ?? null,
        soDocNo: so?.doc_no ?? null,
        itemCode: r.item_code,
        supplier: bedVariants(l.desc2),
        variants: r.variants || {},
        soVariants: so ? (so.variants || {}) : null,
        receivedQty: Number(r.received_qty ?? 0),
        grnLines: Number(grnLines),
        doLines: Number(doLines),
        soReadyQty: Number(so?.stock_qty_ready ?? 0),
        soAllocatedBatch: so?.allocated_batch_no ?? null,
      });
    }
    docs.push({ poNumber: po.po_number, supplierDoc: d.supplierDoc, pairs });
  }

  const { writes, holds, agreed } = planBedframeVariantFill(docs);

  rule();
  line(`   supplier documents with a bedframe        ${withBed.length}`);
  line(`   comparable (our PO found, sizes agree)    ${docs.length}`);
  line(`   not comparable                            ${skipped.length}`);
  line(`   lines already agreeing                    ${agreed}`);
  line(`   lines TO WRITE                            ${writes.length}   over ${new Set(writes.map((w) => w.poNumber)).size} purchase order(s)`);
  line(`      of those, FILLING a blank               ${writes.filter((w) => w.filled.length && !w.corrected.length).length}`);
  line(`      of those, CORRECTING a stated number    ${writes.filter((w) => w.corrected.length).length}`);
  line(`   lines HELD                                ${holds.length}   over ${new Set(holds.map((h) => h.poNumber)).size} purchase order(s)`);
  rule();
  for (const w of writes) {
    line(`   WRITE ${w.poNumber.padEnd(16)} ${w.itemCode.padEnd(22)} ${[...w.filled, ...w.corrected].join(' · ')}`
      + `   sales line ${w.soDocNo ?? 'not linked'}`);
  }
  rule();
  for (const h of holds) line(`   HELD  ${h.poNumber.padEnd(16)} ${h.itemCode.padEnd(22)} ${h.why}`);
  rule();
  for (const s of skipped.slice(0, 10)) line(`   skip  ${s}`);
  if (skipped.length > 10) line(`   ... and ${skipped.length - 10} more not comparable`);

  if (!APPLY) {
    rule();
    line('DRY-RUN — nothing was written.');
    line(`To write: APPLY=1 CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    rule();
    let poWritten = 0;
    let soWritten = 0;
    const byPo = new Map();
    for (const w of writes) {
      if (!byPo.has(w.poNumber)) byPo.set(w.poNumber, []);
      byPo.get(w.poNumber).push(w);
    }
    for (const [poNumber, group] of byPo) {
      await sql.begin(async (t) => {
        for (const w of group) {
          const patch = JSON.stringify(w.set);
          await t`UPDATE scm.purchase_order_items
                     SET variants = coalesce(variants, '{}'::jsonb) || ${patch}::jsonb
                   WHERE id = ${w.poItemId}`;
          poWritten += 1;
          if (w.soItemId) {
            await t`UPDATE scm.mfg_sales_order_items
                       SET variants = coalesce(variants, '{}'::jsonb) || ${patch}::jsonb
                     WHERE id = ${w.soItemId}`;
            soWritten += 1;
          }
        }
      });
      line(`   written  ${poNumber}  ${group.length} line(s)`);
    }
    line(`APPLIED — ${poWritten} purchase line(s), ${soWritten} sales line(s).`);

    /* VERIFY on a FRESH connection, asserting the SHAPE: every axis this run
       meant to write now reads the number the supplier states. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const ids = writes.map((w) => w.poItemId);
      const after = ids.length
        ? await check`SELECT id, item_code, variants FROM scm.purchase_order_items WHERE id = ANY(${ids})`
        : [];
      const byId = new Map(after.map((r) => [String(r.id), r]));
      const bad = [];
      for (const w of writes) {
        const row = byId.get(String(w.poItemId));
        if (!row) { bad.push(`${w.poNumber} ${w.itemCode}: row gone`); continue; }
        for (const [k, v] of Object.entries(w.set)) {
          const got = (row.variants || {})[k];
          if (inches(got) !== inches(v)) bad.push(`${w.poNumber} ${w.itemCode}: ${k} reads ${got ?? '(blank)'}, wanted ${v}`);
        }
      }
      if (bad.length) {
        line(`VERIFY FAILED — ${bad.length} line/axis pair(s) did not land: ${bad.slice(0, 8).join(' · ')}`);
        process.exitCode = 1;
      } else {
        const axes = writes.reduce((a, w) => a + Object.keys(w.set).length, 0);
        line(`VERIFY OK — ${writes.length} line(s), ${axes} measurement(s), re-read on a fresh connection.`);
      }
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}

/* BED_AXES is imported for its aliases; naming it here keeps the import honest
   for a reader who wonders which axes this tool believes in. */
void BED_AXES;
