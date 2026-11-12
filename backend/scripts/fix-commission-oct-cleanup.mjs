#!/usr/bin/env node
// fix-commission-oct-cleanup.mjs — owner 2026-11-12, Event Commission
// (「我想要重新清洗，因为10月还是有很多不准」 … 做). Two October clean-ups, both
// through the code the Fair Links page uses and both written to each order's
// History. No amount is touched.
//
//   1. LINK the two bed-frame "Bill 2" orders whose branding (BEDFRAME) kept the
//      fair picker from finding a booth, to the booth their Bill 1 and their
//      evening sales report name: HC-SO-2610-037 and HC-SO-2610-065 → project 363
//      (Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY, 2–4/10). transferOrdersToFairs
//      moves the venue and the fair day with the link, as a move on Fair Links does.
//   2. FILL what an October-fair order's own evening sales report proves: a blank
//      Fair Day (the report's day, when it falls inside the fair's period) and a
//      typed venue that is not its fair's venue. Only orders the report lists AT
//      THEIR OWN FAIR; no order is moved.
//
// MODE=plan (default) lists every change and writes nothing. MODE=apply needs
// CONFIRM="CLEAN OCTOBER FAIRS". Prints doc numbers, fair ids, venues and dates
// only — no money (the Actions log is public).
// Env: DATABASE_URL, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { transferOrdersToFairs, transferFairDay } from '../src/scm/lib/fair-transfer.ts';
import { recordFairChange, fairStateOf } from '../src/scm/lib/fair-audit.ts';
import { loadReportEvidence, sightingsOf } from '../src/routes/lib/sales-report-evidence.ts';

const CONFIRM_PHRASE = 'CLEAN OCTOBER FAIRS';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;
const CO = Number(process.env.COMPANY_ID || 1);
const ACTOR = 'Finance clean-up (owner 2026-11-12)';
const LINKS = [
  { docNo: 'HC-SO-2610-037', projectId: 363 },
  { docNo: 'HC-SO-2610-065', projectId: 363 },
];
const FROM = '2026-10-01';
const TO = '2026-10-31';
const say = (s) => console.log(s);
const dayOf = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) || null);
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const sb = pgrestShim(sql, 'scm');
  const db = d1Compat(() => sql);
  const companySql = ` AND p.company_id = ${CO}`;
  say(`fix-commission-oct-cleanup   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);
  try {
    /* 1. The two Bill 2 links. */
    say('\n1. Link to their fair');
    const links = await sql`
      SELECT doc_no, project_id, fair_match, status FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND doc_no IN ${sql(LINKS.map((l) => l.docNo))}`;
    for (const l of LINKS) {
      const o = links.find((r) => r.doc_no === l.docNo);
      say(`   ${l.docNo}: now ${o ? `${o.fair_match ?? '-'} #${o.project_id ?? '-'} ${o.status}` : 'NOT FOUND'} → #${l.projectId}`);
    }
    if (APPLY) {
      const res = await transferOrdersToFairs({ sb, db, companySql, companyId: CO, items: LINKS, actorId: null, actorName: ACTOR });
      for (const r of res) say(`   ${r.docNo}: ${r.ok ? `linked to #${r.projectId}, venue ${r.venue}, fair day ${r.fairDate ?? '-'}` : `NOT linked (${r.reason})`}`);
    }

    /* 2. Fill a blank fair day / a wrong venue that the order's own report proves. */
    say(`\n2. Fill fair day / venue on orders of fairs starting ${FROM}..${TO}`);
    const fairs = await sql`
      SELECT id, name, venue, start_date, end_date FROM public.projects
       WHERE company_id = ${CO} AND start_date >= ${FROM} AND start_date <= ${TO}`;
    const fairById = new Map(fairs.map((f) => [Number(f.id), f]));
    const ids = [...fairById.keys()];
    const orders = ids.length ? await sql`
      SELECT doc_no, project_id, fair_match, venue, venue_source, fair_date, customer_so_no, ref, status
        FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND project_id IN ${sql(ids)} AND status <> 'CANCELLED'
       ORDER BY doc_no` : [];
    const evidence = await loadReportEvidence(db, companySql, { projectIds: ids });
    let planned = 0; let written = 0;
    for (const o of orders) {
      if (LINKS.some((l) => l.docNo === o.doc_no)) continue;
      const fair = fairById.get(Number(o.project_id));
      const seen = sightingsOf(o, evidence).filter((s) => s.projectId === Number(o.project_id));
      if (!fair || seen.length === 0) continue;
      const period = { startDate: dayOf(fair.start_date), endDate: dayOf(fair.end_date) };
      const reportDay = seen.map((s) => s.reportDate).filter(Boolean).sort()[0] ?? null;
      const dayNow = dayOf(o.fair_date);
      const dayNew = dayNow ?? transferFairDay(period, reportDay, null);
      const venueNow = o.venue ?? null;
      const venueNew = norm(venueNow) === norm(fair.venue) ? venueNow : String(fair.venue ?? '').trim() || venueNow;
      const also = [
        { field: 'venue', from: venueNow, to: venueNew },
        { field: 'fairDate', from: dayNow, to: dayNew },
      ].filter((c) => (c.from ?? '') !== (c.to ?? ''));
      if (also.length === 0) continue;
      planned += 1;
      say(`   ${o.doc_no} fair #${fair.id}: ${also.map((c) => `${c.field} ${c.from ?? '-'} → ${c.to ?? '-'}`).join('; ')}`);
      if (!APPLY) continue;
      const patch = {};
      for (const c of also) {
        if (c.field === 'venue') { patch.venue = c.to; patch.venue_source = 'PMS'; }
        if (c.field === 'fairDate') patch.fair_date = c.to;
      }
      const { error } = await sb.from('mfg_sales_orders').update(patch).eq('doc_no', o.doc_no).eq('company_id', CO);
      if (error) { say(`      NOT written (${error.message ?? 'update failed'})`); continue; }
      const state = fairStateOf(o);
      await recordFairChange({
        sb, db, companySql, docNo: o.doc_no, before: state, after: state, how: 'settle',
        actorId: null, actorName: ACTOR,
        note: `Filled from its evening sales report${reportDay ? ` of ${reportDay}` : ''} at this fair (Finance clean-up).`,
        also,
      });
      written += 1;
    }
    say(`\n   ${planned} order(s) to fill${APPLY ? `, ${written} written` : ''}`);
    if (!APPLY) say(`\nNothing written. To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
