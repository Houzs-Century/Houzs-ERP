#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. The owner's two questions, 2026-09-01, answered as counts:
//   「全部 furtherdescription 有的照片都进来了？」
//   「再来全部照片都解析了？」
//
// They are DIFFERENT questions and the answer to one is not the answer to the
// other, which is the whole reason this exists:
//
//   DECODED  — the book's picture came out of the RTF as real pixels. The
//              measure is the committed manifests, which hold one row per
//              successfully decoded image (`bytes`, `w`, `h`). A picture that
//              failed to decode is simply ABSENT from them, so this script
//              cannot count those and says so rather than implying zero.
//   ARRIVED  — that image is on the ERP line, i.e. the line's photo_urls is
//              non-empty. Matched by AutoCount DtlKey, the line's own identity.
//
// So the honest shape of the answer is a funnel, and every step is printed:
//   lines the book has a photo for  ->  decoded into a manifest row
//     ->  the ERP line exists and is linked  ->  that line carries a photo
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Counts and document
// NUMBERS only — never an item code, a customer, a colour or an amount. Document
// numbers are printed for at most SHOW rows so a person can go and look.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction.
//
//   DATABASE_URL   required
//   COMPANY        default 1
//   SHOW           how many missing document numbers to name (default 15)
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
const COMPANY = Number(process.env.COMPANY ?? 1);
const SHOW = Number(process.env.SHOW ?? 15);
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

async function side(label, file, table, joinSql) {
  const rows = manifest(file);
  log('');
  if (!rows) { log(`${label}: NO MANIFEST on disk — cannot answer for this side.`); return; }

  /* One manifest row is one IMAGE; a line can carry several. Both numbers are
     printed because "5,289 photos" and "2,164 lines" are different facts and
     quoting the wrong one overstates coverage. */
  const byKey = new Map();
  for (const r of rows) {
    const k = Number(r.DtlKey);
    if (!Number.isFinite(k)) continue;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  const keys = [...byKey.keys()];
  log(`${label}`);
  log(`  DECODED out of the book: ${rows.length} image(s) across ${keys.length} line(s)`);

  const live = await sql.unsafe(
    `SELECT i.linked_ac_dtlkey::bigint AS dtl, ${joinSql.docCol} AS doc,
            COALESCE(array_length(i.photo_urls, 1), 0) AS pics
       FROM scm.${table} i ${joinSql.join}
      WHERE ${joinSql.where} AND i.linked_ac_dtlkey = ANY($1::bigint[])`,
    [keys]);

  const seen = new Map(live.map((r) => [Number(r.dtl), r]));
  const notLinked = keys.filter((k) => !seen.has(k));
  const withPics = live.filter((r) => Number(r.pics) > 0);
  const withoutPics = live.filter((r) => Number(r.pics) === 0);

  log(`  the ERP has that line:   ${live.length} of ${keys.length}`
    + `   (no ERP line carries that AutoCount key: ${notLinked.length})`);
  log(`  and it CARRIES a photo:  ${withPics.length} of ${live.length}`
    + `   -> ARRIVED on ${withPics.length} of the book's ${keys.length} photographed line(s)`);
  if (withoutPics.length) {
    const docs = [...new Set(withoutPics.map((r) => r.doc))];
    log(`  MISSING — the book has a photo, the ERP line exists and has none: ${withoutPics.length}`
      + ` line(s) on ${docs.length} document(s)`);
    log(`     ${docs.slice(0, SHOW).join(', ')}${docs.length > SHOW ? `, +${docs.length - SHOW} more` : ''}`);
  }
}

async function main() {
  log(`READ-ONLY line-photo coverage — company ${COMPANY}`);
  log('DECODED is measured from the committed manifests; a picture the extractor');
  log('could NOT decode leaves no row there, so this cannot count those. Only the');
  log('exporter run on the AutoCount host reports the undecodable tail.');

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

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
