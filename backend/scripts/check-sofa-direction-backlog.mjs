#!/usr/bin/env node
/* check-sofa-direction-backlog - how much sofa DIRECTION work is actually left,
 * under the owner's scope ruling of 2026-09-10.  READ-ONLY.  SELECT only, no
 * writes, no DDL, no transaction.
 *
 * WHY IT EXISTS.  The TV-direction round (docs/bugs/0774) re-read 112 sofa lines
 * and corrected 20 documents.  I reported the remainder as "~476 still to check"
 * and the owner cut the scope rather than the standard:
 *
 *     你只需要看那些还没proceed的单就行了，后期的他们会跟 Supplier 拿那些 list，
 *     因为 Supplier 那边是有记录到 by compartment 跟它的全部 variants 的
 *
 * An order that has been PROCEEDED has gone to the supplier, and the supplier's
 * own record carries the build by compartment with every variant.  Staff will
 * retrieve those.  So the work we still owe is the NOT-PROCEEDED half, and this
 * script measures it instead of quoting 476 again.
 *
 * PROCEEDED is "the order has a Processing Date", and the column NAME is taken
 * from lib/so-processing-date.mjs rather than typed here.  There have been three
 * names: mig 0189 dropped a dead `processing_date`, then mig 0286 renamed
 * `internal_expected_dd` INTO `processing_date` (applied on prod 2026-08-13).
 * This script's first draft hand-typed the retired name, which is exactly what
 * that helper exists to stop - a column that does not exist is 42703, and 42703
 * fails the WHOLE statement, so the census would have reported nothing at all
 * rather than a smaller truth.
 *
 * MIRROR-PROOF IS COMPUTED FIRST, AND IT IS MOST OF THE POPULATION.  A mirror is
 * "reverse the piece order and swap every (LHF)/(RHF)".  A build whose mirror
 * equals itself CANNOT have been recorded the wrong way round - one left and one
 * right are needed either way - so it needs no drawing opened.  On the 112 lines
 * of the last round, 42 were mirror-proof (docs/bugs/0774).  Computing it costs
 * nothing and it is the difference between a real backlog and a scary number.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.  It does not say which at-risk build is
 * WRONG - only a drawing says that, and the owner's rule is that the TV decides
 * (memory: sofa-handedness-is-mirrored).  It lists them so they can be read.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     optional, default 1
 *   LIST_LIMIT     optional, default 60 - how many at-risk documents to name
 */
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorrections } from './lib/sofa-corrections-source.mjs';
import { soProcessingDateFragment } from './lib/so-processing-date.mjs';

const CO = Number(process.env.COMPANY_ID || 1);
const LIMIT = Number(process.env.LIST_LIMIT || 60);
const here = path.dirname(fileURLToPath(import.meta.url));

const line = (s = '') => console.log(`::notice::${s}`);
const rule = () => line('-'.repeat(78));
const head = (s) => { line('='.repeat(78)); line(s); line('='.repeat(78)); };

/* The compartment suffix: 9028-1A(LHF) -> 1A(LHF). Same reader the corrections
   applier and the middle-reverser use, so the three agree on what a piece is. */
const suffix = (code) => {
  const s = String(code ?? '');
  const i = s.indexOf('-');
  return (i < 0 ? s : s.slice(i + 1)).toUpperCase();
};
const swapHand = (p) => p.replace(/\((LHF|RHF)\)/g, (_, h) => (h === 'LHF' ? '(RHF)' : '(LHF)'));
const mirror = (pieces) => pieces.slice().reverse().map(swapHand);
const isMirrorProof = (pieces) => {
  const m = mirror(pieces);
  return m.length === pieces.length && m.every((p, i) => p === pieces[i]);
};

/* Self-test the predicate at startup. A checker that cannot match reports a
   clean run, and this repo has paid for that three times (CLAUDE.md). */
{
  const cases = [
    [['1A(LHF)', '1NA', '1A(RHF)'], true],
    [['1A(LHF)', '1NA', 'CNR', '1A(RHF)'], false],
    [['L(LHF)', '1NA', '1A(RHF)'], false],
    [['3S'], true],
    [['1A(LHF)', 'CNR', 'CNR', '1A(RHF)'], true],
  ];
  for (const [pieces, want] of cases) {
    if (isMirrorProof(pieces) !== want) {
      console.error(`SELF-TEST FAILED: ${pieces.join('+')} should be ${want ? '' : 'not '}mirror-proof. `
        + 'Refusing to report from a dead predicate.');
      process.exit(1);
    }
  }
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
const PDATE = soProcessingDateFragment(sql);

try {
  const rows = await sql`
    SELECT i.doc_no, i.line_no, i.item_code,
           h.${PDATE} IS NOT NULL AS proceeded,
           coalesce(h.status::text, '') AS status,
           coalesce(h.debtor_name, '') AS customer,
           coalesce(array_length(i.photo_urls, 1), 0) AS pics
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND lower(coalesce(i.item_group, '')) = 'sofa'
       AND coalesce(i.cancelled, false) = false
     ORDER BY i.doc_no, i.line_no, i.id`;

  const docs = new Map();
  for (const r of rows) {
    let d = docs.get(r.doc_no);
    if (!d) docs.set(r.doc_no, (d = { doc: r.doc_no, proceeded: r.proceeded, status: r.status, customer: r.customer, pieces: [], pics: 0 }));
    d.pieces.push(suffix(r.item_code));
    d.pics += Number(r.pics || 0);
  }

  /* Documents the correction rounds already answered - those are decided, not
     outstanding, and counting them as work is the mistake memory
     mark-accepted-divergences names. */
  const corrected = new Set();
  try {
    const loaded = loadCorrections(path.join(here, 'data'));
    /* A build names every document it belongs to - the SO and its PO - so add
       them all; only the SO numbers will ever match the census. */
    for (const b of loaded.builds) for (const d of b.docs || []) corrected.add(d);
    for (const h of loaded.held) for (const d of h.docs || []) corrected.add(d);
    line(`corrections loaded: ${loaded.builds.length} build(s), ${loaded.held.length} held, ${corrected.size} document(s) named`);
  } catch (e) {
    line(`(correction files not readable here: ${e.message} - nothing is subtracted)`);
  }

  const all = [...docs.values()];
  const bucket = (list) => ({
    n: list.length,
    proof: list.filter((d) => isMirrorProof(d.pieces)).length,
    risk: list.filter((d) => !isMirrorProof(d.pieces)),
    lines: list.reduce((a, d) => a + d.pieces.length, 0),
  });

  const notProc = bucket(all.filter((d) => !d.proceeded));
  const proc = bucket(all.filter((d) => d.proceeded));

  head('SOFA DIRECTION BACKLOG - scoped by the owner 2026-09-10');
  line(`   company ${CO}.  Sofa lines are rows with item_group = 'sofa', cancelled rows excluded.`);
  line('   PROCEEDED = the order has a Processing Date.');
  line("   Owner: a PROCEEDED order's build comes back from the SUPPLIER, who records it");
  line('   by compartment with every variant.  Those are NOT ours to re-read.');
  line('');
  line(`   sofa documents in total                    ${all.length}   (${rows.length} compartment lines)`);
  line(`   PROCEEDED - the supplier answers these      ${proc.n}   (${proc.lines} lines)`);
  line(`   not proceeded - OURS                        ${notProc.n}   (${notProc.lines} lines)`);
  rule();
  line('OF THE NOT-PROCEEDED HALF - the only half we owe');
  rule();
  line(`   mirror-proof, cannot be wrong either way    ${notProc.proof}`);
  line(`   at risk (the mirror differs from itself)    ${notProc.risk.length}`);

  const outstanding = notProc.risk.filter((d) => !corrected.has(d.doc));
  const done = notProc.risk.length - outstanding.length;
  line(`      of those, already corrected in a round   ${done}`);
  line(`      STILL TO READ                            ${outstanding.length}`);
  line('');
  line('   A mirror is "reverse the pieces and swap every (LHF)/(RHF)". A build whose');
  line('   mirror equals itself needs no drawing opened - both ends are the same piece.');

  if (outstanding.length) {
    rule();
    /* A DRAWING IS THE ONLY THING THAT DECIDES DIRECTION, so a document with no
       photograph is not work anybody can do - it is a question for the owner or
       the supplier. Splitting these apart is the difference between a backlog
       and a list of impossible tasks. */
    const withPic = outstanding.filter((d) => d.pics > 0);
    const noPic = outstanding.filter((d) => d.pics === 0);
    line(`      of those, a drawing is ON THE LINE       ${withPic.length}   <- readable now`);
    line(`      NO drawing anywhere on the document      ${noPic.length}   <- nothing to read`);
    line('');
    line(`STILL TO READ, drawing present - ${withPic.length} document(s)`);
    rule();
    for (const d of withPic.slice(0, LIMIT)) {
      line(`   ${d.doc.padEnd(15)} ${(d.customer || '').slice(0, 22).padEnd(23)} ${d.status.padEnd(12)} ${String(d.pics).padStart(2)} pic  ${d.pieces.join('+')}`);
    }
    if (withPic.length > LIMIT) line(`   ... and ${withPic.length - LIMIT} more (raise LIST_LIMIT)`);
    rule();
    line(`NO DRAWING - ${noPic.length} document(s). Direction cannot be decided from our data.`);
    rule();
    for (const d of noPic.slice(0, LIMIT)) {
      line(`   ${d.doc.padEnd(15)} ${(d.customer || '').slice(0, 22).padEnd(23)} ${d.status.padEnd(12)} ${d.pieces.join('+')}`);
    }
    if (noPic.length > LIMIT) line(`   ... and ${noPic.length - LIMIT} more (raise LIST_LIMIT)`);
  }

  head('READ-ONLY.  Nothing above was written.');
  line('Which at-risk build is actually WRONG is decided by the drawing, and the TV in it');
  line("decides the hand (TV below the run = the drawing's left arm is LHF). This script");
  line('does not guess one.');
} finally {
  await sql.end({ timeout: 5 });
}
