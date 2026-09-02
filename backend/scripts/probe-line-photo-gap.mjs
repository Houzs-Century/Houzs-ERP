#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. Splits the number probe-line-photo-coverage.mjs leaves unexplained.
//
// That probe reports, per photographed AutoCount line, how many ERP ROWS carry
// a picture. A sofa build is several ERP rows for ONE AutoCount line and the
// importer deliberately hangs the photograph on the FIRST piece only (owner
// 2026-08-10: 「每个 SKU 的照片都一样,留第一个就可以了」), so its siblings count
// as "no photo" and inflate the gap. Two different facts were being added up.
//
// So this asks the question at the level the book asks it — per AutoCount LINE:
//
//   the book photographed this line
//     -> the ERP has at least one row for it        (else: never migrated)
//        -> some row of it carries a key            = ARRIVED
//        -> no row of it carries any key            = MISSING, and this is the
//                                                     only number worth chasing
//
// SECOND, and independent: a key can be attached and still show nothing. The
// key embeds the ERP row id (`<so|po>-items/<doc>/<row id>/ac-<DtlKey>-<n>.jpg`).
// Round 1's keys were minted before the 2026-08-28 re-import replaced every row
// id, so a key naming a DIFFERENT id than the row it hangs on is a round-1 key,
// whose object was listed in R2 on 2026-08-10. A key naming the row's OWN id was
// minted by the 2026-08-31 attach pass, whose upload step
// (docs/ac-resync-runbook.md 阶段 3b step 2) has no recorded run. This cannot
// read R2 and does not pretend to — it reports which shape each line depends on,
// so the ones at risk are a NAMED list rather than a worry.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Counts and document
// NUMBERS only — no item code, customer, colour or amount.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction.
//
//   DATABASE_URL   required
//   COMPANY        default 1
//   SHOW           how many document numbers to name per bucket (default 20)
//
// RE-RUN: idempotent and side-effect free.
// ----------------------------------------------------------------------------
import postgres from 'postgres';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const COMPANY = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 20);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const here = path.dirname(fileURLToPath(import.meta.url));

function manifest(file) {
  const p = path.join(here, 'data', file);
  if (!fs.existsSync(p)) return null;
  const raw = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.items ?? []);
}

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });
const list = (a) => `${a.slice(0, SHOW).join(', ')}${a.length > SHOW ? `, +${a.length - SHOW} more` : ''}`;

async function side(label, file, table, joinSql) {
  const rows = manifest(file);
  log('');
  if (!rows) { log(`${label}: NO MANIFEST on disk — cannot answer for this side.`); return; }

  const keys = [...new Set(rows.map((r) => Number(r.DtlKey)).filter(Number.isFinite))];
  log(`${label}  — the book photographed ${keys.length} line(s), ${rows.length} image(s)`);

  const live = await sql.unsafe(
    `SELECT i.id::text AS id, i.linked_ac_dtlkey::bigint AS dtl, ${joinSql.docCol} AS doc,
            COALESCE(i.photo_urls, '{}'::text[]) AS pics,
            lower(COALESCE(i.item_group, '')) = 'sofa' AS is_sofa
       FROM scm.${table} i ${joinSql.join}
      WHERE ${joinSql.where} AND i.linked_ac_dtlkey = ANY($1::bigint[])`,
    [keys]);

  /* Group ERP rows by the AutoCount line they came from — that is the unit the
     book photographs and the unit the owner's question is about. */
  const byLine = new Map();
  for (const r of live) {
    const k = Number(r.dtl);
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(r);
  }

  const arrived = [], missing = [], missingSofa = [], missingPlain = [], missingDetail = [];
  const imgPerKey = new Map();
  for (const r of rows) { const k = Number(r.DtlKey); imgPerKey.set(k, (imgPerKey.get(k) ?? 0) + 1); }
  let siblingsQuiet = 0;
  for (const [, group] of byLine) {
    const withPic = group.filter((r) => r.pics.length > 0);
    if (withPic.length) {
      arrived.push(group[0].doc);
      siblingsQuiet += group.length - withPic.length;
    } else {
      missing.push(group[0].doc);
      (group[0].is_sofa ? missingSofa : missingPlain).push(group[0].doc);
      /* Named one per line, with what the book holds for it, because "10 lines"
         is a number you cannot act on and "this document, 2 pictures, 3 ERP
         rows, none carrying one" is a thing somebody can go and fix. */
      missingDetail.push(`${group[0].doc}  AC line ${group[0].dtl}  book has ${imgPerKey.get(Number(group[0].dtl)) ?? '?'} picture(s), ERP holds ${group.length} row(s)${group[0].is_sofa ? ' [sofa build]' : ''}`);
    }
  }
  const notMigrated = keys.length - byLine.size;

  log(`  never migrated — no ERP row carries that AutoCount line: ${notMigrated}`);
  log(`  in the ERP: ${byLine.size} line(s), held as ${live.length} row(s)`);
  log(`     ARRIVED — some row of the line carries the picture: ${arrived.length}`);
  log(`        (of their rows, ${siblingsQuiet} carry none BY DESIGN — one build, one photo, on the first piece)`);
  log(`     MISSING — the line is in the ERP and NO row of it carries a picture: ${missing.length}`);
  if (missing.length) {
    log(`        sofa: ${missingSofa.length} line(s) on ${new Set(missingSofa).size} document(s)`);
    log(`        other: ${missingPlain.length} line(s) on ${new Set(missingPlain).size} document(s)`);
    log(`        ${list([...new Set(missing)])}`);
    for (const d of missingDetail) log(`        - ${d}`);
  }

  /* Which shape of key the arrived lines are standing on. */
  const own = new RegExp(`/([0-9a-f-]{36})/ac-`);
  let selfOnly = 0, roundOne = 0, mixed = 0, unparsed = 0;
  const selfOnlyDocs = [];
  for (const r of live) {
    if (!r.pics.length) continue;
    let s = 0, o = 0;
    for (const k of r.pics) {
      const m = own.exec(k);
      if (!m) { unparsed++; continue; }
      if (m[1] === r.id) s++; else o++;
    }
    if (s && o) mixed++;
    else if (s) { selfOnly++; selfOnlyDocs.push(r.doc); }
    else if (o) roundOne++;
  }
  log(`  key shape on the rows that carry one:`);
  log(`     round-1 key only (object listed in R2 on 2026-08-10): ${roundOne}`);
  log(`     2026-08-31 minted key only (depends on an upload with no recorded run): ${selfOnly}`);
  log(`     both shapes on the row: ${mixed}${unparsed ? `; unparseable keys: ${unparsed}` : ''}`);
  if (selfOnly) log(`        ${list([...new Set(selfOnlyDocs)])}`);
}

/* ---------------------------------------------------------------------------
   WHY a photographed line has no ERP row. There are only two answers and they
   mean opposite things: the whole DOCUMENT was never migrated (the cutover took
   OUTSTANDING documents only — expected, and the owner's call to change), or the
   document IS here and the line was not matched (ours to explain and fix). The
   funnel above cannot tell them apart, and the owner asked directly.
   --------------------------------------------------------------------------- */
async function docLevel(label, file, headerTable, acCol, docCol) {
  const rows = manifest(file);
  log('');
  if (!rows) { log(`${label}: NO MANIFEST on disk.`); return; }

  const byDoc = new Map();          // AutoCount doc no -> Set(DtlKey)
  for (const r of rows) {
    const d = String(r.DocNo || '').trim();
    const k = Number(r.DtlKey);
    if (!d || !Number.isFinite(k)) continue;
    if (!byDoc.has(d)) byDoc.set(d, new Set());
    byDoc.get(d).add(k);
  }
  const docs = [...byDoc.keys()];

  const erp = await sql.unsafe(
    `SELECT trim(h.linked_ac_docno) AS ac, ${docCol} AS doc
       FROM scm.${headerTable} h
      WHERE h.company_id = ${COMPANY} AND h.linked_ac_docno IS NOT NULL
        AND trim(h.linked_ac_docno) = ANY($1::text[])`, [docs]);
  const erpByAc = new Map(erp.map((r) => [r.ac, r.doc]));

  const keys = [...new Set(rows.map((r) => Number(r.DtlKey)).filter(Number.isFinite))];
  const live = await sql.unsafe(
    `SELECT DISTINCT i.linked_ac_dtlkey::bigint AS dtl FROM scm.${acCol.table} i ${acCol.join}
      WHERE ${acCol.where} AND i.linked_ac_dtlkey = ANY($1::bigint[])`, [keys]);
  const haveKey = new Set(live.map((r) => Number(r.dtl)));

  let docHere = 0, docGone = 0;
  let lineOnMissingDoc = 0, lineOnPresentDoc = 0;
  const orphanSamples = [], wholeSamples = [];
  for (const [ac, dtlSet] of byDoc) {
    const here = erpByAc.has(ac);
    if (here) docHere++; else docGone++;
    const unmatched = [...dtlSet].filter((k) => !haveKey.has(k));
    if (!here) { lineOnMissingDoc += unmatched.length; continue; }
    if (unmatched.length) {
      lineOnPresentDoc += unmatched.length;
      if (orphanSamples.length < SHOW) orphanSamples.push(`${erpByAc.get(ac)} (AC ${ac}) ${unmatched.length}/${dtlSet.size} line(s) unmatched`);
    } else if (wholeSamples.length < 8) {
      wholeSamples.push(`${erpByAc.get(ac)} (AC ${ac}) ${dtlSet.size} photographed line(s), all present`);
    }
  }

  log(`${label} — the book photographed ${docs.length} document(s)`);
  log(`  that document is in the ERP:      ${docHere}`);
  log(`  that document is NOT in the ERP:  ${docGone}   (the cutover imported OUTSTANDING documents only)`);
  log(`  photographed lines with no ERP row: ${lineOnMissingDoc + lineOnPresentDoc}`);
  log(`     because the whole document was never migrated: ${lineOnMissingDoc}`);
  log(`     the document IS here, the line is not matched:  ${lineOnPresentDoc}`);
  if (orphanSamples.length) for (const s of orphanSamples) log(`        ${s}`);
  log(`  SAMPLE — documents in the ERP whose photographed lines are ALL present:`);
  for (const s of wholeSamples) log(`        ${s}`);
}

/* ---------------------------------------------------------------------------
   The measurement above finds an ERP line by `linked_ac_dtlkey`. A line whose
   key was never stamped is therefore INVISIBLE to it and reads as "the book's
   line is not in the ERP" — even when the row is sitting there carrying its
   photograph, because the attach script matches on document + item code, not on
   the key. So the two must be separated before anyone chases the difference.
   --------------------------------------------------------------------------- */
async function keyStamping(label, table, join, where) {
  const [r] = await sql.unsafe(
    `SELECT count(*)::int AS lines,
            count(*) FILTER (WHERE i.linked_ac_dtlkey IS NULL)::int AS no_key,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(i.photo_urls) u WHERE u LIKE '%/ac-%'))::int AS with_pic,
            count(*) FILTER (WHERE i.linked_ac_dtlkey IS NULL
                               AND EXISTS (SELECT 1 FROM unnest(i.photo_urls) u WHERE u LIKE '%/ac-%'))::int AS pic_no_key
       FROM scm.${table} i ${join} WHERE ${where}`);
  log('');
  log(`${label} — key stamping`);
  log(`  lines in the ERP: ${r.lines}; of them with NO AutoCount line key: ${r.no_key}`);
  log(`  lines carrying an AutoCount photograph: ${r.with_pic}`);
  log(`  ... carrying one but with NO key, so the funnel above cannot see them: ${r.pic_no_key}`);
}

async function main() {
  log(`READ-ONLY line-photo GAP split — company ${COMPANY}`);
  await side('SALES ORDER lines', 'ac-photo-manifest.json.gz', 'mfg_sales_order_items', {
    docCol: 'i.doc_no',
    join: 'JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no',
    where: `h.company_id = ${COMPANY}`,
  });
  await side('PURCHASE ORDER lines', 'ac-po-photo-manifest.json.gz', 'purchase_order_items', {
    docCol: 'h.po_number',
    join: 'JOIN scm.purchase_orders h ON h.id = i.purchase_order_id',
    where: `h.company_id = ${COMPANY}`,
  });
  log('');
  log('============ WHY the un-migrated ones are un-migrated ============');
  await docLevel('SALES ORDERS', 'ac-photo-manifest.json.gz', 'mfg_sales_orders',
    { table: 'mfg_sales_order_items', join: 'JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no', where: `h.company_id = ${COMPANY}` },
    'h.doc_no');
  await docLevel('PURCHASE ORDERS', 'ac-po-photo-manifest.json.gz', 'purchase_orders',
    { table: 'purchase_order_items', join: 'JOIN scm.purchase_orders h ON h.id = i.purchase_order_id', where: `h.company_id = ${COMPANY}` },
    'h.po_number');
  log('');
  log('============ can the funnel SEE every line? ============');
  await keyStamping('SALES ORDER lines', 'mfg_sales_order_items',
    'JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no', `h.company_id = ${COMPANY}`);
  await keyStamping('PURCHASE ORDER lines', 'purchase_order_items',
    'JOIN scm.purchase_orders h ON h.id = i.purchase_order_id', `h.company_id = ${COMPANY}`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
