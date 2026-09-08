#!/usr/bin/env node
// ---------------------------------------------------------------------------
// READ-ONLY. TWO NUMBERS NOBODY HAS EVER MEASURED, AND BOTH DECIDE A DEFAULT.
//
// A. HOW MANY MIGRATED DELIVERY LINES CAN COLOUR ACTUALLY PAIR?
//    buildMigratedDoPlan buckets candidate sales-order lines on (AutoCount SO
//    number, ERP item code) and takes them BY POSITION. The account book's
//    delivery line carries no colour and no line key — `fromSoDtlKey` is
//    populated on 10,792 of 18,890 PO lines and 0 of 48,772 DO lines in the
//    2026-09-08 re-cut — so two lines of one sofa model in different fabrics
//    are paired by sequence, and a disagreement is an exact swap that copies
//    the other customer's colour onto the note (docs/bugs/0672, instance 2:
//    DO-011505 and DO-011478).
//
//    The standing rule is: pair on model + colour, and where that does not
//    resolve it, write NO link and list it for a person. This section runs the
//    REAL planner — the same buildMigratedDoPlan the two importers call — over
//    the book's whole DO population against the live sales-order lines, and
//    reports how many lines it pairs and how many it now leaves for a person.
//    Running the real function rather than restating its rule in SQL is the
//    point: a probe that re-implements the thing it measures measures itself.
//
// B. HOW MANY LINE PHOTOS SIT WHERE THE PHOTO'S OWNER IS A COIN FLIP?
//    planRepoint (scripts/lib/line-photo-keys.mjs) groups by (document,
//    AutoCount DtlKey) and, when the book gives no line key of its own, sends
//    the picture to `firstRow(group)`. It already REFUSES a group holding two
//    models (the isOneModel guard, 0684). What it does not refuse is two rows
//    of ONE model in different colours — and a sofa's compartments legitimately
//    share one DtlKey, so multi-row groups are the normal case, not the
//    exception. Nobody has counted how many photos are actually in that
//    position; the recommendation on file says to look at the number before
//    choosing a default, and this is that number.
//
//    It also answers the two things that would CHANGE the answer: whether any
//    such group spans two documents, and whether the rows in it can be told
//    apart by colour at all.
//
// PRIVACY. This repository and its Actions logs are PUBLIC. Document numbers
// and item codes are printed because neither decision can be reviewed without
// them; docs/bugs/0672 already publishes both. No customer or supplier NAME and
// no money is printed anywhere in this file.
//
// NOTHING IS WRITTEN. SELECTs only. No DDL, no transaction, no temp table.
//
//   DATABASE_URL   required
//   COMPANY        default 1
//
// RE-RUN: idempotent and side-effect free. Safe to run any number of times.
// ---------------------------------------------------------------------------
import path from 'node:path';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import { buildMigratedDoPlan, loadAcErpItemMap, norm } from './lib/migrated-do-writer.mjs';
import { variantIdentity } from './lib/do-so-item-pairing.mjs';
import { decomposeGroup } from './lib/sofa-compartment-suffixes.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

async function sectionA() {
  log('=== A. MIGRATED DELIVERY LINES: what colour can pair, and what it leaves for a person ===');
  const truth = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', 'ac-reconcile-truth.json.gz'))));
  const LF = truth.line_fields;
  const idx = Object.fromEntries(LF.map((k, i) => [k, i]));
  const doLines = truth.types.DO.lines;
  log(`   book: ${doLines.length} delivery lines, cut ${truth.exported_at}`);

  const rows = doLines
    .filter((l) => l[idx.fromDocType] === 'SO' && l[idx.fromDocNo])
    .map((l) => ({
      DoNo: l[idx.docNo], DoDate: null, SoNo: l[idx.fromDocNo],
      ItemCode: l[idx.itemKey], LineDesc: null, Qty: Number(l[idx.qty] || 0),
      DebtorCode: null, DebtorName: null,
    }));
  log(`   of those, ${rows.length} name a sales order and can be paired at all (${pct(rows.length, doLines.length)})`);

  const soItems = await sql`
    SELECT i.id, i.item_code, i.doc_no, i.qty, i.item_group, i.variants, i.description2,
           i.unit_price_sen, i.discount_sen, i.unit_cost_sen,
           replace(h.doc_no, 'HC-', '') AS ac
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.company_id = ${CO}
     ORDER BY i.doc_no, i.line_no NULLS LAST, i.id`;
  log(`   ERP: ${soItems.length} sales-order lines for company ${CO}`);

  const itemMap = loadAcErpItemMap(path.join(here, 'data'));
  const { stats } = buildMigratedDoPlan({ rows, itemMap, soItems: soItems.map((r) => ({ ...r })) });

  const paired = rows.length - stats.unmapped - stats.noSoLine - stats.exhausted - stats.collapsed - stats.ambiguousColour;
  log('');
  log(`   PAIRED ${paired} of ${rows.length} book delivery lines (${pct(paired, rows.length)})`);
  log(`   LISTED FOR A PERSON, colour cannot say which line: ${stats.ambiguousColour} (${pct(stats.ambiguousColour, rows.length)})`);
  log(`   other refusals, unchanged by this rule: unmapped ${stats.unmapped}, no ERP line ${stats.noSoLine}, no unclaimed line left ${stats.exhausted}, whole build already on the note ${stats.collapsed}`);

  const docs = new Set();
  for (const [doNo, d] of stats.byDoc) if (d.dropped.some((x) => /different colours/.test(x.why || ''))) docs.add(doNo);
  log(`   they sit on ${docs.size} delivery note(s)`);
  let shown = 0;
  for (const [doNo, d] of stats.byDoc) {
    for (const x of d.dropped) {
      if (!/different colours/.test(x.why || '')) continue;
      if (shown++ >= 25) break;
      log(`      ${doNo} <- ${x.so}  ${x.code}: ${x.why}`);
    }
    if (shown >= 25) break;
  }
  if (docs.size > 25) log(`      ... and ${docs.size - 25} more note(s)`);
}

async function sectionB() {
  log('');
  log('=== B. LINE PHOTOS: how many sit in a group where the owning line is a coin flip? ===');
  log('   A group is (document, AutoCount DtlKey) — the SAME key planRepoint groups by.');
  log('   isOneModel already refuses a group of two models; what is unguarded is two');
  log('   rows of ONE model, which is what a sofa build always is.');

  for (const arm of [
    { name: 'sales order', table: 'scm.mfg_sales_order_items', join: 'JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no', doc: 'i.doc_no' },
    { name: 'purchase order', table: 'scm.purchase_order_items', join: 'JOIN scm.purchase_orders h ON h.id = i.purchase_order_id', doc: 'h.po_number' },
  ]) {
    const rows = await sql.unsafe(`
      SELECT ${arm.doc} AS doc, i.linked_ac_dtlkey::text AS dtl, i.item_code AS code,
             i.variants, i.description2,
             COALESCE(array_length(i.photo_urls, 1), 0) AS pics
        FROM ${arm.table} i ${arm.join}
       WHERE h.company_id = $1 AND i.linked_ac_dtlkey IS NOT NULL`, [CO]);

    const groups = new Map();
    for (const r of rows) {
      const k = `${r.doc}|${r.dtl}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const multi = [...groups.entries()].filter(([, g]) => g.length > 1);
    const withPics = multi.filter(([, g]) => g.some((r) => r.pics > 0));
    const photos = withPics.reduce((n, [, g]) => n + g.reduce((m, r) => m + r.pics, 0), 0);
    const oneModel = multi.filter(([, g]) => decomposeGroup(g.map((r) => r.code)).ok
      || new Set(g.map((r) => String(r.code).toUpperCase().split('-')[0])).size === 1);
    const colourSplit = withPics.filter(([, g]) => new Set(g.map((r) => variantIdentity(r))).size > 1);

    const byKeyDocs = new Map();
    for (const r of rows) {
      if (!byKeyDocs.has(r.dtl)) byKeyDocs.set(r.dtl, new Set());
      byKeyDocs.get(r.dtl).add(r.doc);
    }
    const spanning = [...byKeyDocs.entries()].filter(([, d]) => d.size > 1);

    log('');
    log(`   ${arm.name}: ${rows.length} line(s) carry a book line key, in ${groups.size} (document, key) group(s)`);
    log(`      groups holding MORE THAN ONE row: ${multi.length} (${pct(multi.length, groups.size)})`);
    log(`      of those, groups that actually hold a PHOTO: ${withPics.length}, carrying ${photos} photo(s)`);
    log(`      of THOSE, groups whose rows can be told apart by colour: ${colourSplit.length}`);
    log(`      of THOSE, groups whose rows can NOT be told apart by colour: ${withPics.length - colourSplit.length}`);
    log(`      multi-row groups that are one model decomposed into compartments: ${oneModel.length} of ${multi.length}`);
    log(`      book line keys carried on MORE THAN ONE document: ${spanning.length}`);
    if (spanning.length) {
      for (const [k, d] of spanning.slice(0, 10)) log(`         key ${k} on ${[...d].join(', ')}`);
    }
  }
  log('');
  log('   WHAT THIS DOES NOT ANSWER. planRepoint never crosses documents — `doc` is');
  log('   in its group key and its candidates come from that document only — so the');
  log('   spanning count above is about the OTHER instruments that group by key');
  log('   alone (probe-line-photo-gap.mjs:83), not about a photo planRepoint could');
  log('   move between two documents.');
}

async function main() {
  log(`company=${CO}`);
  await sectionA();
  await sectionB();
  await sql.end({ timeout: 5 });
}

main().catch((e) => { console.error(e); process.exit(1); });
