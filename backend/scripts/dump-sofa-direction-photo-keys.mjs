#!/usr/bin/env node
/* dump-sofa-direction-photo-keys - the DRAWINGS that still have to be read, and
 * the build each one is supposed to prove. READ-ONLY. SELECT only, no writes,
 * no DDL, no transaction. It emits a JSON worklist; nothing acts on it.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * `check-sofa-direction-backlog` counts the work: 180 not-proceeded sofa
 * documents are at risk and 129 of them carry a drawing (run 34485790937). This
 * turns that count into the thing somebody can actually work from - one row per
 * document with its current piece list and its R2 photo keys, so the images can
 * be pulled and read against the owner's rule.
 *
 * THE RULE, and it is his: 「主要是看TV的 要看TV在上还是下」. TV drawn BELOW the
 * run means the arm on the drawing's LEFT is the LHF piece; TV ABOVE means the
 * whole build is mirrored. 「如果没有tv的就当作tv在下面」.
 *
 * ── WHAT IT LEAVES OUT, AND WHY THAT IS THE POINT ──────────────────────────
 * PROCEEDED documents. The owner scoped this: 「你只需要看那些还没proceed的单就
 * 行了」 - a proceeded order's build comes back from the supplier, who records it
 * by compartment with every variant. Re-reading those drawings would re-derive
 * a fact somebody else already holds.
 *
 * MIRROR-PROOF builds. A build whose mirror equals itself cannot have been
 * recorded the wrong way round, so its drawing settles nothing. Computed here
 * exactly as the backlog census computes it, by the same predicate.
 *
 * Documents a correction round already answered.
 *
 * ── THE 51 WITH NO DRAWING ARE EMITTED TOO, IN THEIR OWN LIST ──────────────
 * They are not work anybody can do: no photo, not proceeded, so neither we nor
 * the supplier holds the answer. Listing them as "to read" would be a backlog of
 * impossible tasks; dropping them silently would hide a real gap. They go in
 * `noDrawing` so the owner can see exactly which orders need asking about.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   OUT            optional path for the JSON; default stdout
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadCorrections } from './lib/sofa-corrections-source.mjs';
import { soProcessingDateFragment } from './lib/so-processing-date.mjs';

const CO = Number(process.env.COMPANY_ID || 1);
const OUT = process.env.OUT || '';
const here = path.dirname(fileURLToPath(import.meta.url));

const log = (s = '') => console.log(`::notice::${s}`);
const suffix = (code) => {
  const s = String(code ?? '');
  const i = s.indexOf('-');
  return (i < 0 ? s : s.slice(i + 1)).toUpperCase();
};
const swapHand = (p) => p.replace(/\((LHF|RHF)\)/g, (_, h) => (h === 'LHF' ? '(RHF)' : '(LHF)'));
const isMirrorProof = (pieces) => {
  const m = pieces.slice().reverse().map(swapHand);
  return m.length === pieces.length && m.every((p, i) => p === pieces[i]);
};

/* Same self-test as the census, for the same reason: a predicate that stops
   matching would quietly empty this worklist instead of failing. */
for (const [pieces, want] of [
  [['1A(LHF)', '1NA', '1A(RHF)'], true],
  [['1A(LHF)', '1NA', 'CNR', '1A(RHF)'], false],
  [['3S'], true],
]) {
  if (isMirrorProof(pieces) !== want) {
    console.error(`SELF-TEST FAILED on ${pieces.join('+')}. Refusing to emit a worklist from a dead predicate.`);
    process.exit(1);
  }
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
const PDATE = soProcessingDateFragment(sql);

try {
  const rows = await sql`
    SELECT i.doc_no, i.line_no, i.item_code, i.photo_urls,
           h.${PDATE} IS NOT NULL AS proceeded,
           coalesce(h.status::text, '') AS status,
           coalesce(h.debtor_name, '') AS customer,
           coalesce(i.description2, '') AS desc2,
           i.linked_ac_dtlkey::text AS dtlkey
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND lower(coalesce(i.item_group, '')) = 'sofa'
       AND coalesce(i.cancelled, false) = false
     ORDER BY i.doc_no, i.line_no, i.id`;

  const docs = new Map();
  for (const r of rows) {
    let d = docs.get(r.doc_no);
    if (!d) {
      docs.set(r.doc_no, (d = {
        doc: r.doc_no, proceeded: r.proceeded, status: r.status, customer: r.customer,
        pieces: [], keys: [], desc2: new Set(), dtlkeys: new Set(),
      }));
    }
    d.pieces.push(suffix(r.item_code));
    for (const k of r.photo_urls ?? []) if (k) d.keys.push(k);
    if (r.desc2) d.desc2.add(r.desc2);
    if (r.dtlkey) d.dtlkeys.add(r.dtlkey);
  }

  const corrected = new Set();
  const loaded = loadCorrections(path.join(here, 'data'));
  for (const b of loaded.builds) for (const x of b.docs || []) corrected.add(x);
  for (const h of loaded.held) for (const x of h.docs || []) corrected.add(x);

  const all = [...docs.values()].map((d) => ({
    ...d,
    desc2: [...d.desc2],
    dtlkeys: [...d.dtlkeys],
    keys: [...new Set(d.keys)],
  }));

  const atRisk = all.filter((d) => !d.proceeded && !isMirrorProof(d.pieces) && !corrected.has(d.doc));
  const toRead = atRisk.filter((d) => d.keys.length);
  const noDrawing = atRisk.filter((d) => !d.keys.length);

  log(`company ${CO}: ${all.length} sofa document(s); ${atRisk.length} at risk and unanswered`);
  log(`   with a drawing, READABLE NOW   ${toRead.length}   (${toRead.reduce((a, d) => a + d.keys.length, 0)} image key(s))`);
  log(`   NO drawing, cannot be decided  ${noDrawing.length}`);

  const out = {
    _rule: 'TV drawn BELOW the run: the arm on the drawing LEFT is LHF. TV ABOVE: the build is mirrored. No TV: treat as below (owner 2026-09-10).',
    _scope: 'NOT-proceeded documents only, not mirror-proof, not already answered by a corrections round.',
    _generated: new Date().toISOString(),
    company: CO,
    toRead: toRead.map((d) => ({
      doc: d.doc, customer: d.customer, status: d.status,
      pieces: d.pieces, dtlkeys: d.dtlkeys, desc2: d.desc2, keys: d.keys,
    })),
    noDrawing: noDrawing.map((d) => ({
      doc: d.doc, customer: d.customer, status: d.status, pieces: d.pieces, desc2: d.desc2,
    })),
  };

  const json = `${JSON.stringify(out, null, 1)}\n`;
  if (OUT) { fs.writeFileSync(OUT, json); log(`written to ${OUT} (${json.length} bytes)`); }
  else console.log(json);
} finally {
  await sql.end({ timeout: 5 });
}
