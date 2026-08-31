#!/usr/bin/env node
// READ-ONLY. "I saved this document — did the change reach AutoCount, and if
// not, what stopped it?" Answered for ONE named document.
//
// THE QUESTION (owner, 2026-08-31): he edited a sales order — deleted a line,
// added a bedframe, changed variants, uploaded photos — and wants to know
// whether AutoCount got it. The queue health report answers for the POPULATION
// and probe-outbox-queued-or-not.mjs answers in ordinals; neither can answer
// "this one". This script takes the document number and reports its own rows.
//
// WHAT IT PRINTS, AND WHAT IT DELIBERATELY DOES NOT. This repository is PUBLIC,
// Actions logs included, so nothing here quotes a customer, an address, an item
// code or an amount. `last_error` in particular is NEVER printed verbatim — a
// keyless-line refusal names real item codes. It is CLASSIFIED into a code
// (keyless_line, mislinked_grn, conversion_pending, ...) and only the code is
// shown, with the raw text's LENGTH so a truncation is still visible. The
// document number is printed because you passed it in.
//
// The line counts are the other half of the answer: composeEdit refuses the
// WHOLE document when any line carries no AutoCount key, so "keyless: 2" is
// usually the reason an edit never left, and it is a count, not a name.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no writes, no transaction.
//
//   DATABASE_URL   required
//   DOC_NO         required — the ERP document number (SO doc_no or PO number)
//   COMPANY_ID     default 1
//
// RE-RUN: idempotent and side-effect free. Run it as often as you like.
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const DOC = (process.env.DOC_NO ?? '').trim();
if (!DOC) { console.error('DOC_NO required'); process.exit(2); }
const COMPANY = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* Known refusal shapes, newest first. Each pattern is a phrase composeEdit /
   enqueueEdit / the drain actually writes; anything unmatched is reported as
   `other` with its length, never quoted. */
const REASON_CODES = [
  [/carry no AutoCount .*DtlKey/i, 'keyless_line — a line on this document has no AutoCount key, so the whole edit is refused'],
  [/edited before its AutoCount counterpart existed/i, 'conversion_pending — the document was edited while its conversion was still queued'],
  [/refused to edit in AutoCount/i, 'mislinked_grn — the AutoCount link names the PO, not the GRN'],
  [/no stock location|Location/i, 'no_location — a line has no stock location'],
  [/Desc2|too long/i, 'desc2_too_long — the description exceeds AutoCount\'s field'],
  [/sofa|compartment/i, 'sofa_collapse — the build could not be collapsed into one AutoCount line'],
  [/timeout|ETIMEDOUT|ECONNREFUSED|fetch failed|tunnel/i, 'host_unreachable — the AutoCount host did not answer'],
  [/FK_|foreign key/i, 'autocount_foreign_key — AutoCount refused a master (agent, location, term)'],
];
const classify = (raw) => {
  const s = String(raw ?? '');
  if (!s.trim()) return null;
  for (const [re, code] of REASON_CODES) if (re.test(s)) return code;
  return `other (${s.length} chars, not printed)`;
};

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  log(`document ${DOC}, company ${COMPANY}`);

  const [flag] = await sql`SELECT value::text AS value, updated_at
      FROM scm.app_config WHERE key = 'scm.autocount_writeback'`;
  log(`write-back switch: ${flag?.value ?? '(no row)'} (last moved ${flag?.updated_at ?? 'n/a'})`);

  /* SO first, then PO — the two shapes a human hands you a number for. */
  const [so] = await sql`SELECT doc_no, status::text AS status, linked_ac_docno, updated_at
      FROM scm.mfg_sales_orders WHERE doc_no = ${DOC} AND company_id = ${COMPANY}`;
  const [po] = await sql`SELECT id, po_number, status::text AS status, linked_ac_docno, updated_at
      FROM scm.purchase_orders WHERE po_number = ${DOC} AND company_id = ${COMPANY}`;

  if (!so && !po) {
    log('NO SUCH DOCUMENT in this company. Check the number and the company id.');
    await sql.end();
    return;
  }

  if (so) {
    log(`SALES ORDER: status ${so.status}; in AutoCount: ${so.linked_ac_docno ? 'YES' : 'NO'}; last saved ${so.updated_at}`);
    const [lc] = await sql`SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE linked_ac_dtlkey IS NOT NULL)::int AS keyed,
             COUNT(*) FILTER (WHERE linked_ac_dtlkey IS NULL)::int AS keyless,
             COUNT(*) FILTER (WHERE cancelled)::int AS cancelled
        FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC}`;
    log(`  lines: ${lc.total} total, ${lc.keyed} carry an AutoCount key, ${lc.keyless} do NOT, ${lc.cancelled} cancelled`);
    if (lc.keyless > 0) {
      log('  ^ ANY keyless line refuses the WHOLE edit unless the route declared it as newly added.');
    }
  }
  if (po) {
    log(`PURCHASE ORDER: status ${po.status}; in AutoCount: ${po.linked_ac_docno ? 'YES' : 'NO'}; last saved ${po.updated_at}`);
    const [lc] = await sql`SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE linked_ac_dtlkey IS NOT NULL)::int AS keyed,
             COUNT(*) FILTER (WHERE linked_ac_dtlkey IS NULL)::int AS keyless
        FROM scm.purchase_order_items WHERE purchase_order_id = ${po.id}`;
    log(`  lines: ${lc.total} total, ${lc.keyed} carry an AutoCount key, ${lc.keyless} do NOT`);
  }

  const rows = await sql`SELECT op, doc_type, status, attempts, created_at, sent_at, last_error,
             (ac_doc_no IS NOT NULL) AS got_ac_doc_no
      FROM scm.autocount_outbox
     WHERE doc_no = ${DOC} AND company_id = ${COMPANY}
     ORDER BY created_at`;
  log('');
  log(`QUEUE ROWS FOR THIS DOCUMENT: ${rows.length}`);
  if (!rows.length) {
    log('  NONE. The ERP never offered this document to AutoCount at all — the save');
    log('  happened, the push did not. Check the switch above, then the route: an');
    log('  enqueue that returns early writes nothing anywhere.');
  }
  for (const r of rows) {
    const reason = classify(r.last_error);
    log(`  ${String(r.created_at).slice(0, 19)}  ${r.op.padEnd(10)} ${r.doc_type}  ${r.status.padEnd(8)}`
      + ` attempts=${r.attempts}${r.sent_at ? ` sent=${String(r.sent_at).slice(0, 19)}` : ''}`
      + `${r.got_ac_doc_no ? ' (AutoCount answered with a document number)' : ''}`);
    if (reason) log(`      why: ${reason}`);
  }

  const stuck = rows.filter((r) => r.status === 'pending');
  const bad = rows.filter((r) => r.status === 'failed' || r.status === 'skipped');
  log('');
  log(`VERDICT: ${rows.filter((r) => r.status === 'sent').length} sent, ${stuck.length} still queued, ${bad.length} failed or skipped.`);
  if (bad.length) log('A failed or skipped row is the answer to "why is it not in AutoCount".');
  else if (stuck.length) log('Still queued: the drain runs every 5 minutes. Re-run this in 5 minutes.');

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
