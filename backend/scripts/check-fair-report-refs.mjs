#!/usr/bin/env node
// check-fair-report-refs.mjs — READ-ONLY. Could the evening sales report a
// fair's chat carries (one line per bill: booklet number, amount, who sold it)
// tell which fair each Sales Order belongs to, by its Ref No.?
//
// WHY. The owner, 2026-10-16, wants a submitted order to find its fair without
// the salesperson choosing. The report (owner 2026-10-14, routes/project-sales-
// bills.ts) already names, per booth, the booklet numbers sold there. This
// measures how much of that exists: per fair, whether a report was pasted and
// how its bills match orders; per order, which fair's report lists its Ref No.
// against the fair the order is linked to now. Same parsing and matching as the
// project page (routes/lib/sales-report-bills.ts), imported, not re-written.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01).
//   npx tsx scripts/check-fair-report-refs.mjs

import postgres from 'postgres';
import { collectReport, indexOrdersByToken, matchBill } from '../src/routes/lib/sales-report-bills.ts';
import { extractRefTokens } from '../src/scm/shared/sales-report-parse.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const minusDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10); };
const label = (p) => (p ? `${p.id}:${p.brand ?? '?'}@${p.venue}/${day(p.start_date)}` : '—');

try {
  const projects = await sql`
    SELECT id, name, venue, brand, organizer, start_date, end_date
      FROM public.projects
     WHERE company_id = ${CO} AND archived_at IS NULL AND start_date IS NOT NULL
       AND start_date >= ${minusDays(FROM, 30)} AND start_date <= ${new Date().toISOString().slice(0, 10)}
     ORDER BY start_date, id`;
  const byId = new Map(projects.map((p) => [Number(p.id), p]));
  const notes = projects.length ? await sql`
    SELECT pa.id, pa.project_id, pa.note, pa.created_at, u.email AS author_email, pos.name AS author_position
      FROM public.project_activity pa
      LEFT JOIN public.users u ON u.id = pa.user_id
      LEFT JOIN public.positions pos ON pos.id = u.position_id
     WHERE pa.project_id IN ${sql(projects.map((p) => Number(p.id)))} AND pa.action = 'note' AND pa.archived_at IS NULL` : [];
  const notesOf = new Map();
  for (const n of notes) {
    const k = Number(n.project_id);
    if (!notesOf.has(k)) notesOf.set(k, []);
    notesOf.get(k).push({ id: Number(n.id), note: n.note, created_at: iso(n.created_at), author_email: n.author_email, author_position: n.author_position });
  }

  const orders = await sql`
    SELECT doc_no, project_id, status::text AS status, customer_so_no, ref, salesperson_id::text AS salesperson_id,
           local_total_sen, total_revenue_sen, so_date, fair_match
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND status::text <> 'CANCELLED' AND so_date >= ${minusDays(FROM, 30)}`;
  const index = indexOrdersByToken(orders.map((o) => ({ ...o, project_id: o.project_id != null ? Number(o.project_id) : null })));

  /* 1. Per fair: was a report pasted, and what do its bills match? */
  const listedIn = new Map(); // token → Set(project id)
  let withReport = 0;
  const rows = [];
  for (const p of projects) {
    const { bills } = collectReport(notesOf.get(Number(p.id)) ?? [], day(p.start_date) || null);
    if (bills.length === 0) { rows.push(`  ${label(p)} | no report`); continue; }
    withReport += 1;
    const t = { opened: 0, same: 0, other: 0, unlinked: 0, notOpened: 0 };
    for (const b of bills) {
      if (!listedIn.has(b.ref_token)) listedIn.set(b.ref_token, new Set());
      listedIn.get(b.ref_token).add(Number(p.id));
      const m = matchBill(b.ref_token, Number(p.id), index);
      if (m.status === 'opened') { t.opened += 1; if (m.other_event) t.other += 1; else if (m.unlinked) t.unlinked += 1; else t.same += 1; }
      else t.notOpened += 1;
    }
    rows.push(`  ${label(p)} | bills ${bills.length} | order found ${t.opened} (this fair ${t.same}, other fair ${t.other}, no fair ${t.unlinked}) | not keyed ${t.notOpened}`);
  }
  console.log(`company ${CO}: fairs starting ${minusDays(FROM, 30)} → today: ${projects.length}; with an evening report pasted: ${withReport}`);
  for (const r of rows) if (!r.endsWith('no report')) console.log(r);

  /* 2. Per order since FROM: which fair's report lists its Ref No.? */
  const tally = {};
  const bump = (k, sen) => { tally[k] ??= [0, 0]; tally[k][0] += 1; tally[k][1] += Math.round(Number(sen ?? 0) / 100); };
  const odd = [];
  for (const o of orders) {
    if (day(o.so_date) < FROM || o.status === 'DRAFT') continue;
    const tokens = new Set([...extractRefTokens(o.customer_so_no), ...extractRefTokens(o.ref)]);
    const fairs = new Set();
    for (const t of tokens) for (const pid of listedIn.get(t) ?? []) fairs.add(pid);
    const linked = o.project_id != null ? Number(o.project_id) : null;
    let k;
    if (tokens.size === 0) k = 'no Ref No. on the order';
    else if (fairs.size === 0) k = 'Ref No. in no fair report';
    else if (fairs.size > 1) k = 'Ref No. in 2+ fair reports';
    else {
      const pid = [...fairs][0];
      k = linked == null ? 'report names a fair | order NOT linked' : linked === pid ? 'report names a fair | same as the link' : 'report names a fair | order linked ELSEWHERE';
      if (k !== 'report names a fair | same as the link') odd.push(`${k} | ${o.doc_no} | ${day(o.so_date)} | ${o.fair_match ?? 'NULL'} | Ref ${o.customer_so_no ?? o.ref ?? '—'} | now ${label(byId.get(linked) ?? (linked ? { id: linked, venue: '?', start_date: '' } : null))} | report ${label(byId.get(pid))}`);
    }
    bump(`${day(o.so_date) >= '2026-09-26' ? 'from 26/09' : 'before 26/09'} | ${k}`, o.local_total_sen);
  }
  console.log('\norders by what the evening reports say — n | RM');
  for (const k of Object.keys(tally).sort()) console.log(`  ${k} — ${tally[k][0]} | ${tally[k][1].toLocaleString('en-MY')}`);
  console.log('\norders a report places differently from (or where) the link does:');
  for (const l of odd.sort()) console.log('  ' + l);
} finally {
  await sql.end();
}
