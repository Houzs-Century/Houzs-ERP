#!/usr/bin/env node
/* dump-drawer-side-worklist — the side drawers whose hand nobody wrote, split
 * into the three buckets the owner's rule creates. READ-ONLY: SELECT only, no
 * writes, no DDL, no transaction. It emits a worklist; nothing acts on it.
 *
 * ── THE RULE, and it is his (2026-09-13) ───────────────────────────────────
 * 「要看照片 看有没有 要不然就是还没有 proceed 就不需要看」.
 *
 * So a line whose text says only `side drawer` falls into exactly one of:
 *
 *   READ THE PHOTO   — it has a slip photo. Pull the R2 key, read the drawing
 *                      under the convention in drawer-side-owner-rulings.json
 *                      (the side is read AS YOU LOOK AT IT), record the answer
 *                      there with its evidence.
 *   ASK A PERSON     — no photo, but the order IS proceeded. The factory is
 *                      building it now, so the hand has to be settled today and
 *                      only the salesperson or the customer knows it.
 *   LEAVE IT         — no photo and NOT proceeded. Nobody holds the answer and
 *                      nobody needs it yet; it can be asked when the order is
 *                      actually proceeded. Chasing these now is work nobody
 *                      needs, which is exactly what the owner said.
 *
 * ── WHY THE DECODER DECIDES MEMBERSHIP, NOT A TEXT SEARCH ──────────────────
 * `parse-bedframe` already reduces every real spelling — `Sidedrawer`,
 * `2SIDE DRAWER`, `do side drawer`, `drawer at the side` — to the ONE marked
 * phrase `Side Drawer (side unknown)`, and the phrase map deliberately maps that
 * to no catalogue code (docs/bugs/0843). Grepping for the words instead would
 * re-implement that reduction and drift from it. A line is in this worklist when
 * the real decoder produces the marker and no ruling already answers it.
 *
 * ── ALREADY-ANSWERED LINES ARE EXCLUDED ────────────────────────────────────
 * data/drawer-side-owner-rulings.json holds the 12 answered so far. A line it
 * names is not work.
 *
 * RE-RUN: read-only and stateless. A second run reports whatever is true then —
 * and shrinks as rulings are added, which is the point.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   OUT            optional path for the JSON; default stdout summary only
 *   Run under tsx:
 *     npx tsx scripts/dump-drawer-side-worklist.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadPhraseMap, buildLiveIndex, classifyLine, K } from './lib/special-order-phrase-mapper.mjs';
import { soProcessingDateFragment } from './lib/so-processing-date.mjs';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const OUT = (process.env.OUT || '').trim();
const LABEL = '账本原文:';
const MARKER = 'SIDE DRAWER (SIDE UNKNOWN)';
const here = path.dirname(fileURLToPath(import.meta.url));
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));
const norm = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim();
const objOf = (v) => ((v && typeof v === 'object' && !Array.isArray(v)) ? v : null);

function loadSnapshot() {
  try {
    const parsed = JSON.parse(zlib.gunzipSync(
      fs.readFileSync(path.join(here, 'data', 'ac-line-desc2.json.gz'))).toString('utf8'));
    const so = new Map();
    for (const [k, v] of Object.entries(parsed.so ?? {})) so.set(Number(k), String(v ?? ''));
    return { ok: true, so };
  } catch (e) { return { ok: false, so: new Map(), reason: e.message }; }
}

const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });
const PDATE = soProcessingDateFragment(sql);

try {
  line('='.repeat(78));
  line('SIDE DRAWERS WITH NO HAND — the worklist, split by the owner rule');
  line('='.repeat(78));
  line(`   company ${CO}   READ-ONLY`);

  const addons = await sql`
    SELECT code, label, categories, selling_price_sen, cost_price_sen
      FROM scm.special_addons WHERE company_id = ${CO}`;
  const { liveByCat } = buildLiveIndex(addons);
  const map = loadPhraseMap();

  /* Self-test the membership test on REAL spellings before reporting. A worklist
     computed from a decoder that cannot match would read as "nothing left". */
  {
    const marks = (text) => classifyLine({ grp: 'bedframe', code: 'TRION (A)-(K)', d2: text, variants: {} }, map, liveByCat)
      .unmapped.some((u) => K(u) === MARKER);
    const must = ['sidedrawer/PC151-01/divan10/gap12', 'do side drawer/Col:PC151-01',
      'Side Drawer/Col: /Div:8"', 'COL:PC151-03/2SIDE DRAWER'];
    const mustNot = ['Leftside Drawer/Divan:8"', 'add on right side drawer', 'Front Drawer, HB Fully Cover'];
    const bad = [...must.filter((t) => !marks(t)), ...mustNot.filter((t) => marks(t))];
    if (bad.length) {
      console.error(`SELF-TEST FAILED on ${bad.length} real spelling(s). Refusing to emit a worklist from a dead decoder.`);
      for (const t of bad) console.error(`   ${t}`);
      process.exit(1);
    }
    line(`   decoder self-test: ${must.length} must-match and ${mustNot.length} must-not-match spellings all correct`);
  }

  const ruled = new Set();
  {
    const raw = JSON.parse(fs.readFileSync(path.join(here, 'data', 'drawer-side-owner-rulings.json'), 'utf8'));
    for (const r of raw.rulings ?? []) ruled.add(`${r.doc}|${K(r.itemCode)}`);
    line(`   already answered and excluded: ${ruled.size}`);
  }

  const snap = loadSnapshot();
  const rows = await sql`
    SELECT i.id::text AS id, i.doc_no, i.line_no, i.item_code, i.photo_urls,
           i.description2, i.remark, i.variants, i.linked_ac_dtlkey,
           h.${PDATE} IS NOT NULL AS proceeded,
           coalesce(h.status::text, '') AS status,
           coalesce(h.debtor_name, '') AS customer
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND lower(coalesce(i.item_group, '')) = 'bedframe'
       AND coalesce(i.cancelled, false) = false
     ORDER BY i.doc_no, i.line_no`;

  const readPhoto = [];
  const askPerson = [];
  const leaveIt = [];
  for (const r of rows) {
    const rem = norm(r.remark);
    const idx = rem.lastIndexOf(LABEL);
    const dtl = r.linked_ac_dtlkey == null ? null : Number(r.linked_ac_dtlkey);
    const text = norm(r.description2)
      || (idx === -1 ? '' : norm(rem.slice(idx + LABEL.length)))
      || (dtl == null ? '' : (snap.so.get(dtl) ?? ''));
    if (!text) continue;
    const c = classifyLine({ grp: 'bedframe', code: r.item_code, d2: text, variants: objOf(r.variants) ?? {} }, map, liveByCat);
    if (!c.unmapped.some((u) => K(u) === MARKER)) continue;
    if (ruled.has(`${r.doc_no}|${K(r.item_code)}`)) continue;

    const keys = (r.photo_urls ?? []).filter(Boolean);
    const carried = (objOf(r.variants)?.specials ?? []).map(String);
    const entry = {
      doc: r.doc_no, lineNo: r.line_no, itemCode: r.item_code, customer: r.customer,
      status: r.status, proceeded: r.proceeded === true, bookText: text,
      carriesToday: carried, photoKeys: keys,
    };
    if (keys.length) readPhoto.push(entry);
    else if (r.proceeded === true) askPerson.push(entry);
    else leaveIt.push(entry);
  }

  rule();
  line(`   READ THE PHOTO  — has a slip photo, I can answer it     ${readPhoto.length}`);
  line(`   ASK A PERSON    — no photo, but the order IS proceeded   ${askPerson.length}`);
  line(`   LEAVE IT        — no photo, not proceeded, nobody needs it yet  ${leaveIt.length}`);
  line(`   TOTAL still carrying an unstated side drawer            ${readPhoto.length + askPerson.length + leaveIt.length}`);

  const wrongFront = [...readPhoto, ...askPerson, ...leaveIt]
    .filter((e) => e.carriesToday.some((s) => K(s) === K('Front Drawer')));
  line(`   of those, the line TODAY says Front Drawer (the 0824 defect, unrepaired) ${wrongFront.length}`);

  for (const [name, list] of [['READ THE PHOTO', readPhoto], ['ASK A PERSON', askPerson]]) {
    rule();
    line(`   ${name}`);
    for (const e of list) {
      line(`      ${e.doc.padEnd(15)} ${String(e.itemCode).padEnd(24)} ${e.proceeded ? 'proceeded' : '  -      '}`
        + `  carries: ${e.carriesToday.join(', ') || '(nothing)'}`);
      line(`         text: ${e.bookText.slice(0, 100)}`);
      for (const k of e.photoKeys) line(`         photo: ${k}`);
    }
  }
  rule();
  line('   LEAVE IT — listed so the gap is visible, not so anybody works on it:');
  for (const e of leaveIt) {
    line(`      ${e.doc.padEnd(15)} ${String(e.itemCode).padEnd(24)} ${e.status.padEnd(12)}`
      + ` carries: ${e.carriesToday.join(', ') || '(nothing)'}`);
  }

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({
      generatedAt: new Date().toISOString(), companyId: CO,
      rule: 'owner 2026-09-13: read the photo where there is one; no photo and not proceeded = leave it',
      readPhoto, askPerson, leaveIt,
    }, null, 2));
    line(`   worklist written to ${OUT}`);
  }
  rule();
  line('READ-ONLY — nothing was written.');
} finally {
  await sql.end({ timeout: 5 });
}
