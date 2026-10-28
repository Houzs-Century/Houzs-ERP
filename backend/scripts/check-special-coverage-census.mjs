#!/usr/bin/env node
/* READ-ONLY. Answers the owner's question, 2026-09-12: 「还有什么 special?」
 *
 * Three different questions hide inside that one, and they have three different
 * answers. This script reports all three from production, and writes nothing.
 *
 *   1. WHAT OPTIONS EXIST. Every row of scm.special_addons for this company —
 *      the complete picker, sofa and bedframe, active and retired.
 *
 *   2. HOW MANY DOCUMENTS CARRY EACH, across all six documents (sales order,
 *      purchase order, goods received, delivery order, purchase invoice, sales
 *      invoice). An option nobody carries is either genuinely unused or
 *      something we have never managed to fill in.
 *
 *   3. WHICH ONES CAN NEVER BE FILLED AUTOMATICALLY. `apply-book-text-specials`
 *      and `apply-supplier-specials` can only write an option some RULE knows
 *      how to recognise. data/special-order-phrase-map.json holds TWO rule
 *      tables and BOTH count: the `families`, and `cushionSwapModels`, whose
 *      five backrest-swap codes appear in no family. A catalogue code in
 *      neither is invisible to every tool we have and can only be picked by a
 *      person in the form. Reading only the first table invented five such
 *      codes on the first run - docs/bugs/0845.
 *
 * It also reports the FREE TEXT that keeps appearing and maps to no option —
 * the shortlist for what the catalogue is missing. The owner's standing rule is
 * that free text belongs in the special-order NOTE and never in the variant key
 * (memory special-order-text-is-the-home-for-spec), so nothing here is a
 * proposal to invent a code; it is a list for him to choose from.
 *
 * IT WRITES NOTHING. SELECTs only, no DDL, no transaction, no UPDATE anywhere
 * in this file.
 *
 * RE-RUN: read-only and stateless. A second run reports whatever is true then.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   Run under tsx for the TS import:
 *     npx tsx scripts/check-special-coverage-census.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  loadPhraseMap, buildLiveIndex, classifyLine, mapPhrase, K,
} from './lib/special-order-phrase-mapper.mjs';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const LABEL = '账本原文:';
const here = path.dirname(fileURLToPath(import.meta.url));
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));
const pad = (n, w = 5) => String(n).padStart(w);
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

try {
  line('='.repeat(78));
  line('SPECIAL OPTIONS — what exists, what is carried, what no tool can fill');
  line('='.repeat(78));
  line(`   company ${CO}   READ-ONLY`);

  /* ── 1. the catalogue ──────────────────────────────────────────────────── */
  const addons = await sql`
    SELECT code, label, categories, active,
           coalesce(selling_price_sen, 0)::int AS sell
      FROM scm.special_addons WHERE company_id = ${CO}
     ORDER BY code`;
  line(`   catalogue rows: ${addons.length}`);
  const { liveByCat } = buildLiveIndex(addons);

  /* ── 2. how many document lines carry each, across all six ─────────────── */
  const TABLES = [
    ['mfg_sales_order_items', 'sales order', 'JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = $1'],
    ['purchase_order_items', 'purchase order', 'JOIN scm.purchase_orders h ON h.id = i.purchase_order_id AND h.company_id = $1'],
    ['grn_items', 'goods received', 'JOIN scm.grns h ON h.id = i.grn_id AND h.company_id = $1'],
    ['delivery_order_items', 'delivery note', 'JOIN scm.delivery_orders h ON h.id = i.delivery_order_id AND h.company_id = $1'],
    ['purchase_invoice_items', 'purchase invoice', 'JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id AND h.company_id = $1'],
    ['sales_invoice_items', 'sales invoice', 'JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id AND h.company_id = $1'],
  ];
  const carried = new Map();   // K(code) -> { total, byDoc, cats, asWritten }
  const bump = (code, docName, grp) => {
    const k = K(code);
    const e = carried.get(k) ?? { total: 0, byDoc: new Map(), cats: new Map(), asWritten: code };
    e.total += 1;
    e.byDoc.set(docName, (e.byDoc.get(docName) ?? 0) + 1);
    /* The CATEGORY of the line is carried because a phrase means different
       things on the two sides: `fully cover` is HB Fully Cover on a bedframe and
       something else entirely on a sofa. Grouping a legacy spelling under the
       wrong category's code would be the same class of error as reading only
       half the rule table (docs/bugs/0845). */
    const g = grp === 'sofa' ? 'SOFA' : grp === 'bedframe' ? 'BEDFRAME' : 'OTHER';
    e.cats.set(g, (e.cats.get(g) ?? 0) + 1);
    carried.set(k, e);
  };
  for (const [table, docName, join] of TABLES) {
    const rows = await sql.unsafe(
      `SELECT i.variants, lower(coalesce(i.item_group,'')) AS grp FROM scm.${table} i ${join}
        WHERE jsonb_typeof(coalesce(i.variants,'{}'::jsonb)) = 'object'
          AND coalesce(i.variants -> 'specials', '[]'::jsonb) <> '[]'::jsonb`, [CO]);
    for (const r of rows) {
      const o = objOf(r.variants) ?? {};
      for (const s of (Array.isArray(o.specials) ? o.specials : [])) {
        const t = String(s).trim();
        if (t) bump(t, docName, r.grp);
      }
    }
  }

  /* ── 3. which codes ANY rule can produce ───────────────────────────────── */
  const map = loadPhraseMap();
  /* TWO rule sources, not one. `families` is the obvious half; `cushionSwapModels`
     is a SECOND table that mapPhrase consults for the backrest swaps
     (special-order-phrase-mapper.mjs:82-93), and its five codes appear in no
     family. Reading only `families` reported those five as unreachable — a gap
     that does not exist, contradicted by the apply run that had just written
     `Change 8030 Backcushion` onto 23 lines and by this report's own count of
     124 document lines carrying it. docs/bugs/0845. */
  const reachable = new Set([
    ...map.families.map((f) => K(f.code)),
    ...(map.swaps ?? []).map(([, code]) => K(code)),
  ]);
  {
    /* Self-test: a code only the SWAP table can produce must read as reachable,
       and a name no rule mentions must not. A checker that cannot see one of its
       inputs INVENTS a finding, which is the mirror of the trap CLAUDE.md names. */
    const swapOnly = (map.swaps ?? []).map(([, c]) => K(c))
      .find((c) => !map.families.some((f) => K(f.code) === c));
    const ok = (!swapOnly || reachable.has(swapOnly)) && !reachable.has(K('a code no rule mentions'));
    if (!ok) {
      console.error('SELF-TEST FAILED on the reachability set. Refusing to report.');
      process.exit(1);
    }
    line(`   rule sources: ${map.families.length} phrase families + ${(map.swaps ?? []).length} backrest swaps`
      + ` = ${reachable.size} reachable codes`);
  }

  rule();
  line('   THE CATALOGUE, and how many document lines carry each');
  line('   (a rule = some phrase in special-order-phrase-map.json can recognise it,');
  line('    so a tool can fill it in; NO RULE = only a person can pick it)');
  line('');
  line(`   ${'option'.padEnd(38)} ${'cat'.padEnd(9)} ${'rule'.padEnd(8)} lines`);
  const noRule = [];
  const neverCarried = [];
  for (const a of addons) {
    const k = K(a.code);
    const e = carried.get(k);
    const n = e?.total ?? 0;
    const cats = (a.categories ?? []).map((c) => String(c)[0]).join('');
    const has = reachable.has(k);
    if (!has) noRule.push(a.code);
    if (n === 0) neverCarried.push(a.code);
    line(`   ${String(a.code).padEnd(38)} ${cats.padEnd(9)} ${(has ? 'rule' : 'NO RULE').padEnd(8)} ${pad(n)}`
      + (a.active === false ? '   (retired)' : ''));
  }

  rule();
  line(`   options NO TOOL CAN EVER FILL — a person has to pick them: ${noRule.length}`);
  for (const c of noRule) line(`      ${c}`);
  line('');
  line(`   options NO DOCUMENT CARRIES today: ${neverCarried.length}`);
  for (const c of neverCarried) line(`      ${c}`);

  /* A value on a document that is NOT in the catalogue at all. */
  const known = new Set(addons.map((a) => K(a.code)));
  const orphan = [...carried.entries()].filter(([k]) => !known.has(k));
  rule();
  const orphanLines = orphan.reduce((n, [, e]) => n + e.total, 0);
  line(`   values carried on documents that the catalogue does NOT hold: ${orphan.length}`);
  line(`   document lines carrying one of them:                          ${orphanLines}`);
  line('   These are raw slip phrases stamped as specials before the catalogue settled.');
  line('   They RENDER on the document, so nothing is broken to look at — but `specials`');
  line('   composes the inventory key, so every spelling is its OWN stock bucket.');

  /* WHICH OF THEM ARE THE SAME THING, decided by the RULES and not by eye.
     Each legacy value is put back through the same phrase mapper the backfills
     use: if it decodes to a catalogue code, that code is what it MEANS, and
     every spelling decoding to the same code is one option split across many
     buckets. Grouping them by reading them myself would be a guess; grouping
     them with the rules that already govern this data is a measurement. */
  const meansCat = new Map();     // catalogue code -> { lines, spellings: [] }
  const meansNothing = [];
  for (const [, e] of orphan) {
    /* Ask the category the value ACTUALLY appears on, most common first — never
       a fixed SOFA-then-BEDFRAME order, which would file a sofa's `fully cover`
       under the headboard code. */
    const order = [...e.cats].filter(([c]) => c !== 'OTHER').sort((a, b) => b[1] - a[1]).map(([c]) => c);
    let hit = [];
    let via = '';
    for (const cat of (order.length ? order : ['SOFA', 'BEDFRAME'])) {
      hit = mapPhrase(e.asWritten, liveByCat.get(cat), cat, map);
      if (hit.length) { via = cat; break; }
    }
    e.via = via;
    if (!hit.length) { meansNothing.push(e); continue; }
    for (const code of hit) {
      const g = meansCat.get(code) ?? { lines: 0, spellings: [] };
      g.lines += e.total;
      g.spellings.push(e);
      meansCat.set(code, g);
    }
  }
  rule();
  line('   THE LEGACY SPELLINGS, GROUPED BY WHAT THE RULES SAY THEY MEAN.');
  line('   Each row is ONE catalogue option whose stock is split across several buckets');
  line('   purely because the words differ. Folding a row onto its code merges those');
  line('   buckets — which is a STOCK move, so it is an owner decision, not a tidy-up:');
  line('');
  const groups = [...meansCat].sort((a, b) => b[1].lines - a[1].lines);
  for (const [code, g] of groups) {
    line(`   ${code}  —  ${g.lines} line(s) across ${g.spellings.length} spelling(s)`);
    for (const e of g.spellings.sort((a, b) => b.total - a.total).slice(0, 8)) {
      line(`         ${pad(e.total)}  [${e.via}] ${e.asWritten}`);
    }
    if (g.spellings.length > 8) line(`         ... and ${g.spellings.length - 8} more spelling(s)`);
  }
  line('');
  line(`   legacy values the rules can NOT place on any catalogue option: ${meansNothing.length}`
    + `  (${meansNothing.reduce((n, e) => n + e.total, 0)} line(s))`);
  for (const e of meansNothing.sort((a, b) => b.total - a.total).slice(0, 30)) {
    line(`      ${pad(e.total)}  ${e.asWritten}`);
  }
  if (meansNothing.length > 30) line(`      ... and ${meansNothing.length - 30} more`);

  /* ── 4. the free text that maps to nothing ─────────────────────────────── */
  const snap = loadSnapshot();
  const soRows = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.description2, i.remark,
           i.variants, i.linked_ac_dtlkey,
           lower(coalesce(i.item_group, '')) AS grp
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND lower(coalesce(i.item_group, '')) IN ('sofa', 'bedframe')`;
  const unmapped = new Map();
  const sample = new Map();
  let withText = 0;
  for (const r of soRows) {
    const rem = norm(r.remark);
    const idx = rem.lastIndexOf(LABEL);
    const dtl = r.linked_ac_dtlkey == null ? null : Number(r.linked_ac_dtlkey);
    const text = norm(r.description2)
      || (idx === -1 ? '' : norm(rem.slice(idx + LABEL.length)))
      || (dtl == null ? '' : (snap.so.get(dtl) ?? ''));
    if (!text) continue;
    withText += 1;
    const c = classifyLine({ grp: r.grp, code: r.item_code, d2: text, variants: objOf(r.variants) ?? {} }, map, liveByCat);
    for (const u of c.unmapped) {
      unmapped.set(u, (unmapped.get(u) ?? 0) + 1);
      if (!sample.has(u)) sample.set(u, r.doc_no);
    }
  }
  rule();
  line(`   sofa + bedframe sales lines with a book text: ${withText} of ${soRows.length}`);
  line('   the free-text instructions that map to NO option, most common first.');
  line('   These are the shortlist for what the catalogue is missing — the owner');
  line('   decides which deserve a code; nothing here is invented:');
  line('');
  for (const [k, n] of [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    line(`      ${pad(n)}  ${k}   e.g. ${sample.get(k)}`);
  }
  rule();
  line('READ-ONLY — nothing was written.');
} finally {
  await sql.end({ timeout: 5 });
}
