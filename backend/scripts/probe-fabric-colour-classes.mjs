#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. How many migrated sofa / bedframe lines whose AutoCount Desc2
// names a fabric are still sitting with NO colour on the line, and WHY each one
// is - split by the CLASS of mismatch rather than by the string.
//
// The owner's four examples on 2026-09-04 were four rows; what he asked for was
// the class. So this counts classes:
//
//   HAS A CODE          the line already carries a bound colour - out of scope
//   NO BOOK COLOUR      the Desc2 names no colour at all (or only TBC / KIV)
//   PENDING only        "COL: TBC" - the customer has not chosen. NOT a defect
//   PENDING qualified   "Col:BO315-21Pearl(TBC)" - a colour IS named and the
//                       library holds it. His call whether that counts as
//                       chosen; this only NAMES them, it fills nothing
//   RESOLVES            the matcher answers, so a sweep would stamp it. Split
//                       into the mechanism that answered, so the ones that only
//                       work because of the 2026-09-04 widening are countable
//   MISS                the matcher refuses, and the reason is reported: the
//                       book wrote no number ("Col:PC151-"), the library does
//                       not hold the fabric, or two library rows claim the key
//                       and picking either would be a guess
//
// It re-uses the exact reads, the exact decoders and the exact matcher the
// refresh scripts use, so probe and sweep cannot disagree by construction -
// that duplication is what PR #1893 removed and what this file will not
// reintroduce.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Counts, document
// NUMBERS and the fabric CODE text only - no customer, no price, no address.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction, and there is
// deliberately no APPLY switch: filling these lines is a separate backfill.
//
//   DATABASE_URL   required
//   COMPANY        default 1
//   SHOW           how many examples to name per class (default 12)
//
// RE-RUN: idempotent and side-effect free. A second run re-reads and re-prints.
// ----------------------------------------------------------------------------
import postgres from 'postgres';
import { parseSofa, SOFA_MODEL_ALIAS } from './lib/parse-sofa.mjs';
import { parseBedframe } from './lib/parse-bedframe.mjs';
import { buildFabricColourIndex, isPendingColour, pendingColourKind } from './lib/fabric-colour-match.mjs';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const SHOW = Number(process.env.SHOW || 12);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: 'require', prepare: false, max: 1 });

const norm = (s) => (s || '').trim().toUpperCase().replace(/\s+/g, ' ');
const txt = (v) => (v === undefined || v === null ? '' : String(v).trim());
const pick = (v, keys) => { for (const k of keys) { const x = txt((v || {})[k]); if (x) return x; } return ''; };
const CODE_KEYS = ['fabricCode', 'colorCode', 'colourCode', 'fabricColor'];
const modelOf = (code) => {
  const c = norm(code); const d = c.indexOf('-');
  const b = d < 0 ? c : c.slice(0, d);
  return SOFA_MODEL_ALIAS[b] || b;
};

async function main() {
  log(`READ-ONLY fabric-colour class probe - company ${CO}`);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => norm(p.code)));
  const RECL = ['-1S(R)', '-1A(R)(LHF)', '-1A(P)(LHF)', '-1S(P)'];
  const reclOf = (m) => RECL.some((s) => codeSet.has(norm(m + s)));

  /* `active` is SELECTed on purpose. The matcher reads it only where it is
     present, and it is what lets a 2026-08-11 renumbered pair (CH141-8, now
     inactive, and CH141-08, live) be told apart from two competing colours. */
  const fcRows = await sql`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const ix = buildFabricColourIndex(fcRows);
  const { findColour, explainColour } = ix;
  const nLive = fcRows.filter((r) => r.active).length;
  log(`library: ${fcRows.length} rows (${nLive} active, ${fcRows.length - nLive} superseded) across ${new Set(fcRows.map((r) => r.fabric_id)).size} series`);
  log(`index: ${ix.exact.size} exact keys (${ix.exactRefused.size} REFUSED as claimed by two live rows), ${ix.padded.size} zero-padded keys (${ix.paddedRefused.size} refused)`);
  for (const k of [...ix.exactRefused].slice(0, SHOW)) log(`   refused exact key "${k}" - two different library rows claim it, so it resolves to neither`);
  for (const k of [...ix.paddedRefused].slice(0, SHOW)) log(`   refused padded key "${k}" - same`);
  if (ix.aliasUnresolved.length) for (const a of ix.aliasUnresolved) log(`   COLOUR_ALIAS entry is INERT, its target is not in this library: ${a}`);

  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };

  const soRows = await sql`
    SELECT h.doc_no AS doc, i.item_code AS code, i.item_group AS grp, i.description2 AS d2, i.variants
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;
  const poRows = await sql`
    SELECT p.po_number AS doc, i.item_code AS code, i.item_group AS grp, i.description2 AS d2, i.variants
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND p.linked_ac_docno IS NOT NULL`;
  log(`migrated sofa/bedframe lines: SO ${soRows.length}, PO ${poRows.length}`);

  const B = {
    hasCode: [], noBookColour: [], pendingOnly: [], pendingQualified: [],
    resolvesToday: [], resolvesOnlyNow: [], miss: [],
  };
  const missWhy = new Map();
  const newWhy = new Map();

  for (const [pop, rows] of [['SO', soRows], ['PO', poRows]]) {
    for (const r of rows) {
      const rec = { pop, doc: r.doc, grp: r.grp, code: r.code };
      if (pick(r.variants, CODE_KEYS)) { B.hasCode.push(rec); continue; }
      let raw = '';
      if (txt(r.d2)) {
        raw = r.grp === 'sofa'
          ? txt(parseSofa(r.d2, modelOf(r.code), reclOf(modelOf(r.code)), { knownColour }).color)
          : txt(parseBedframe(r.d2).color);
      }
      if (!raw) raw = txt((r.variants || {}).colourLabel);
      rec.raw = raw;
      if (!raw) { B.noBookColour.push(rec); continue; }
      if (isPendingColour(raw)) {
        (pendingColourKind(raw, findColour) === 'qualified' ? B.pendingQualified : B.pendingOnly).push(rec);
        continue;
      }
      const e = explainColour(raw);
      if (!e) {
        B.miss.push(rec);
        /* Why the refusal, in the terms that decide who can act on it. The
           first two are not matcher problems at all: one is the BOOK missing a
           number, the other is the LIBRARY missing a colour. */
        const why = /[A-Z]$|[A-Z][\s#-]*$/i.test(raw.replace(/[^A-Za-z0-9 #-]/g, '')) && !/\d\s*$/.test(raw)
          ? 'the book wrote a series with no colour NUMBER'
          : 'no single library row answers it (absent, or two rows claim it)';
        missWhy.set(why, (missWhy.get(why) || 0) + 1);
        continue;
      }
      rec.hit = `${e.row.fabric_id} / ${e.row.colour_id}`;
      const isNew = e.padded || e.redirected || e.via === 'padded';
      if (isNew) {
        B.resolvesOnlyNow.push(rec);
        const k = e.redirected && e.via !== 'padded' ? 'the library row it names was SUPERSEDED on 2026-08-11; followed to the live one'
          : e.via === 'padded' ? 'the book wrote a 1-digit number the library stores 2-digit (PC151-1 vs PC151-01)'
          : `the padded spelling reached it through the ${e.via} pass`;
        newWhy.set(k, (newWhy.get(k) || 0) + 1);
      } else B.resolvesToday.push(rec);
    }
  }

  const N = soRows.length + poRows.length;
  const pct = (n) => `${((n / Math.max(N, 1)) * 100).toFixed(1)}%`;
  log('');
  log(`=== THE POPULATION (${N} migrated sofa/bedframe lines, company ${CO})`);
  log(`  already carry a colour                       ${String(B.hasCode.length).padStart(5)}  ${pct(B.hasCode.length)}`);
  const gap = N - B.hasCode.length;
  log(`  carry NO colour                              ${String(gap).padStart(5)}  ${pct(gap)}   <- everything below is this number, split`);
  log(`    the book names no colour, or only TBC/KIV  ${String(B.noBookColour.length).padStart(5)}`);
  log(`    TBC/KIV and nothing else named             ${String(B.pendingOnly.length).padStart(5)}   correct as it stands - not chosen yet`);
  log(`    TBC/KIV BESIDE a colour the library holds  ${String(B.pendingQualified.length).padStart(5)}   OWNER DECISION - a code is written; nothing is filled here`);
  log(`    the matcher resolves it                    ${String(B.resolvesToday.length + B.resolvesOnlyNow.length).padStart(5)}   a sweep would stamp these; this probe does not`);
  /* Deliberately NOT called "resolved before this change". This split is over
     MATCHER mechanisms only, and some of these lines reach the matcher at all
     only because the DECODER stopped dropping their colour. The honest
     before/after is the same probe run against origin/main's modules. */
  log(`       of which the matcher answers unwidened  ${String(B.resolvesToday.length).padStart(5)}`);
  log(`       of which need the widened matcher       ${String(B.resolvesOnlyNow.length).padStart(5)}   <- see the PR for the whole-pipeline before/after`);
  log(`    the matcher REFUSES                        ${String(B.miss.length).padStart(5)}   left empty on purpose`);

  log('');
  log('=== THE GAIN, by class');
  if (!B.resolvesOnlyNow.length) log('  none - every line the matcher answers, it already answered');
  for (const [k, n] of [...newWhy.entries()].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(5)}  ${k}`);
  for (const r of B.resolvesOnlyNow.slice(0, SHOW)) log(`     ${r.pop} ${r.doc}  ${r.grp}  book "${r.raw}"  ->  ${r.hit}`);
  if (B.resolvesOnlyNow.length > SHOW) log(`     ... ${B.resolvesOnlyNow.length - SHOW} more (raise SHOW to see them)`);

  log('');
  log('=== THE REFUSALS, by reason - these stay empty, and that is the rule working');
  for (const [k, n] of [...missWhy.entries()].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(5)}  ${k}`);
  const seen = new Set();
  for (const r of B.miss) {
    if (seen.has(r.raw)) continue;
    seen.add(r.raw);
    log(`     ${r.pop} ${r.doc}  ${r.grp}  book "${r.raw}"`);
    if (seen.size >= SHOW) break;
  }

  log('');
  log('=== THE OWNER DECISION still open');
  log(`  ${B.pendingQualified.length} lines write a colour AND a TBC/KIV marker. The code is in the library, so`);
  log('  the matcher can confirm it; whether a marked line counts as CHOSEN is a');
  log('  business question, not a matcher one. Nothing here fills them either way.');
  const pq = new Map();
  for (const r of B.pendingQualified) pq.set(r.raw, (pq.get(r.raw) || 0) + 1);
  for (const [k, n] of [...pq.entries()].sort((a, b) => b[1] - a[1]).slice(0, SHOW)) {
    const h = findColour(k.replace(/\(?\s*\b(TBC|KIV)\b\s*\)?/gi, ' ').trim());
    log(`     ${String(n).padStart(4)}  "${k}"  would be  ${h ? `${h.fabric_id} / ${h.colour_id}` : '-'}`);
  }

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
