#!/usr/bin/env node
// fix-commission-month-cleanup.mjs — owner 2026-11-12, Event Commission: the
// October clean-up (fix-commission-oct-cleanup.mjs, 「我想要重新清洗」) for any
// month, first for September (「9月的我就是要重新算过」 … 做). Two clean-ups, both
// through the code the Fair Links page uses and both written to each order's
// History. No amount is touched, and only orders whose SO date is in the month:
// a later month's orders are left exactly as they are.
//
//   1. LINK the orders named in LINKS to the fair their own evening sales report
//      and their booklet's other bill name (for September: HC-SO-2609-222, the
//      second bill of booklet PG10457, whose first bill HC-SO-013505 is on
//      project 2257 and whose report line at that fair is both bills together).
//      transferOrdersToFairs moves the venue and the fair day with the link, as
//      a move on Fair Links does.
//   2. FILL what an order's own evening sales report proves: a blank Fair Day
//      (the report's day, when it falls inside the fair's period) and a typed
//      venue that is not its fair's venue. Only orders the report lists AT THEIR
//      OWN FAIR, in their own salesperson's line; no order is moved.
//
// MODE=plan (default) lists every change and writes nothing. MODE=apply needs
// CONFIRM="CLEAN <MONTH> FAIRS" (e.g. "CLEAN 2026-09 FAIRS"), then re-reads every
// written order on a fresh connection and exits 1 if one is not as written.
// Prints doc numbers, fair ids, venues and dates only — no money (the Actions
// log is public).
//
// RE-RUN: a second run finds the linked orders already on their fair (the
// transfer answers "already_there" and writes nothing) and every filled fair day
// and venue already equal to its report, so it plans nothing and writes nothing.
// Env: DATABASE_URL, MONTH (YYYY-MM, required), LINKS ("DOC:PROJECT,DOC:PROJECT",
//      optional), COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { transferOrdersToFairs, transferFairDay } from '../src/scm/lib/fair-transfer.ts';
import { recordFairChange, fairStateOf } from '../src/scm/lib/fair-audit.ts';
import { loadReportEvidence, sightingsOf } from '../src/routes/lib/sales-report-evidence.ts';

const MONTH = String(process.env.MONTH ?? '').trim();
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(MONTH)) {
  console.error('MONTH=YYYY-MM is required — refusing, nothing was written.');
  process.exit(2);
}
const CONFIRM_PHRASE = `CLEAN ${MONTH} FAIRS`;
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;
const CO = Number(process.env.COMPANY_ID || 1);
const ACTOR = 'Finance clean-up (owner 2026-11-12)';
const LINKS = String(process.env.LINKS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
  const [docNo, pid] = pair.split(':').map((x) => x.trim());
  if (!docNo || !/^\d+$/.test(pid ?? '')) {
    console.error(`LINKS: "${pair}" is not DOC:PROJECT — refusing, nothing was written.`);
    process.exit(2);
  }
  return { docNo, projectId: Number(pid) };
});
const FROM = `${MONTH}-01`;
const TO = new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)).toISOString().slice(0, 10);
const say = (s) => console.log(s);
const dayOf = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) || null);
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/* A report line is this order's only when its salesperson is the order's: the
   chat writes names short ("WeiPin", "CH", "Luis" for Wei Pin, Chea Huan, Luis
   Teo). A booklet number another person reported is a typo somewhere, not proof. */
export function sameSeller(reported, staffName) {
  const r = String(reported ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const words = String(staffName ?? '').toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  if (!r || words.length === 0) return false;
  const full = words.join('');
  return r === full || r === words.map((w) => w[0]).join('') || full.startsWith(r) || r.startsWith(words[0]);
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const sb = pgrestShim(sql, 'scm');
  const db = d1Compat(() => sql);
  const companySql = ` AND p.company_id = ${CO}`;
  say(`fix-commission-month-cleanup   ${MONTH}   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);
  try {
    /* 1. The links named. */
    say(`\n1. Link to their fair: ${LINKS.length}`);
    const links = LINKS.length === 0 ? [] : await sql`
      SELECT doc_no, project_id, fair_match, status FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND doc_no IN ${sql(LINKS.map((l) => l.docNo))}`;
    for (const l of LINKS) {
      const o = links.find((r) => r.doc_no === l.docNo);
      say(`   ${l.docNo}: now ${o ? `${o.fair_match ?? '-'} #${o.project_id ?? '-'} ${o.status}` : 'NOT FOUND'} → #${l.projectId}`);
    }
    /* What every write should leave behind, checked on a fresh connection at the end. */
    const expected = [];
    if (APPLY && LINKS.length > 0) {
      const res = await transferOrdersToFairs({ sb, db, companySql, companyId: CO, items: LINKS, actorId: null, actorName: ACTOR });
      for (const r of res) {
        say(`   ${r.docNo}: ${r.ok ? `linked to #${r.projectId}, venue ${r.venue}, fair day ${r.fairDate ?? '-'}` : `NOT linked (${r.reason})`}`);
        if (r.ok) expected.push({ docNo: r.docNo, projectId: r.projectId, fairMatch: 'PICKED' });
      }
    }

    /* 2. Fill a blank fair day / a wrong venue that the order's own report proves. */
    say(`\n2. Fill fair day / venue on orders with an SO date ${FROM}..${TO}`);
    const orders = await sql`
      SELECT doc_no, project_id, fair_match, venue, venue_source, fair_date, customer_so_no, ref, status, salesperson_id
        FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND project_id IS NOT NULL AND so_date >= ${FROM} AND so_date <= ${TO} AND status <> 'CANCELLED'
       ORDER BY doc_no`;
    const ids = [...new Set(orders.map((o) => Number(o.project_id)))];
    const fairs = ids.length ? await sql`
      SELECT id, name, venue, start_date, end_date FROM public.projects WHERE company_id = ${CO} AND id IN ${sql(ids)}` : [];
    const fairById = new Map(fairs.map((f) => [Number(f.id), f]));
    const sellerIds = [...new Set(orders.map((o) => o.salesperson_id).filter((x) => x != null).map(String))];
    const sellers = new Map((sellerIds.length ? await sql`SELECT id::text AS id, name FROM scm.staff WHERE id::text IN ${sql(sellerIds)}` : []).map((s) => [s.id, s.name]));
    const evidence = await loadReportEvidence(db, companySql, { projectIds: ids });
    let planned = 0; let written = 0; let otherSeller = 0;
    for (const o of orders) {
      if (LINKS.some((l) => l.docNo === o.doc_no)) continue;
      const fair = fairById.get(Number(o.project_id));
      const atFair = sightingsOf(o, evidence).filter((s) => s.projectId === Number(o.project_id));
      const seen = atFair.filter((s) => sameSeller(s.salesperson, sellers.get(String(o.salesperson_id))));
      if (atFair.length > 0 && seen.length === 0) {
        otherSeller += 1;
        say(`   skip ${o.doc_no} fair #${o.project_id}: its booklet is in another salesperson's report line`);
      }
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
      expected.push({ docNo: o.doc_no, ...('venue' in patch ? { venue: patch.venue } : {}), ...('fair_date' in patch ? { fairDate: patch.fair_date } : {}) });
      const state = fairStateOf(o);
      await recordFairChange({
        sb, db, companySql, docNo: o.doc_no, before: state, after: state, how: 'settle',
        actorId: null, actorName: ACTOR,
        note: `Filled from its evening sales report${reportDay ? ` of ${reportDay}` : ''} at this fair (Finance clean-up).`,
        also,
      });
      written += 1;
    }
    say(`\n   ${planned} order(s) to fill${APPLY ? `, ${written} written` : ''}; ${otherSeller} skipped (another salesperson's report line)`);
    if (!APPLY) say(`\nNothing written. To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);

    if (APPLY && expected.length > 0) {
      /* VERIFY on a fresh connection — the session that wrote is the worst
         witness — that each order now holds exactly what was written. */
      const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
      try {
        const rows = await check`
          SELECT doc_no, project_id, fair_match, venue, fair_date FROM scm.mfg_sales_orders
           WHERE company_id = ${CO} AND doc_no IN ${check(expected.map((e) => e.docNo))}`;
        const now = new Map(rows.map((r) => [r.doc_no, r]));
        const wrong = expected.filter((e) => {
          const r = now.get(e.docNo);
          if (!r) return true;
          if (e.projectId !== undefined && Number(r.project_id) !== e.projectId) return true;
          if (e.fairMatch !== undefined && r.fair_match !== e.fairMatch) return true;
          if (e.venue !== undefined && r.venue !== e.venue) return true;
          return e.fairDate !== undefined && dayOf(r.fair_date) !== e.fairDate;
        });
        say(`\nVerified on a fresh connection: ${expected.length - wrong.length} of ${expected.length} as written`);
        for (const e of wrong) say(`   NOT AS WRITTEN: ${e.docNo}`);
        if (wrong.length > 0) process.exitCode = 1;
      } finally { await check.end(); }
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
