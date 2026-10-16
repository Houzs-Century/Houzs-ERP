#!/usr/bin/env node
// check-so-fair-assignments.mjs — READ-ONLY. Would the salesperson's PMS
// assignment (Sales Attending / PIC) tell which fair an order belongs to?
//
// WHY. The owner, 2026-10-16, on orders the system could not place: 「salesperson
// 也有分 assign to which fair 本身，所以他们 submit 时可以让自动 detect 去哪里一场
// fair」, with 「最近那一场」 when two fit and 「sales person 站的 booth」 when the
// brand has no booth. Before proposing that flow this measures, per order:
//   - how it was entered (the CREATE audit row: web / scan, CONFIRMED / DRAFT);
//   - the fairs its salesperson was assigned to in the 28 days up to the order;
//   - the event + booth that rule picks, against the link the order has now.
// And per fair: how many have anybody on Sales Attending at all.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01).
//   npx tsx scripts/check-so-fair-assignments.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const rm = (sen) => Math.round(Number(sen ?? 0) / 100);
const minusDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10); };
const eventKey = (f) => `${norm(f.venue)}|${norm(f.organizer)}|${day(f.start_date)}|${day(f.end_date)}`;
const label = (f) => (f ? `${f.id}:${f.brand ?? '?'}@${f.venue}/${f.organizer ?? '-'}/${day(f.start_date)}..${day(f.end_date)}` : '—');
const inWindow = (f, d) => day(f.start_date) <= d && (day(f.end_date) || day(f.start_date)) >= minusDays(d, 28);

try {
  const orders = await sql`
    SELECT so.*, st.name AS sp_name, st.user_id AS sp_user_id
      FROM scm.mfg_sales_orders so
      LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text NOT IN ('CANCELLED', 'DRAFT')
     ORDER BY so.so_date, so.doc_no`;
  const docs = orders.map((o) => o.doc_no);
  const created = docs.length ? await sql`
    SELECT DISTINCT ON (so_doc_no) so_doc_no, source, status_snapshot
      FROM scm.mfg_so_audit_log WHERE action = 'CREATE' AND so_doc_no IN ${sql(docs)}
     ORDER BY so_doc_no, created_at` : [];
  const viaOf = new Map(created.map((r) => [r.so_doc_no, `${r.source ?? '?'}/${r.status_snapshot ?? '?'}`]));

  const fairs = await sql`
    SELECT p.id, p.name, p.venue, p.organizer, p.brand, p.start_date, p.end_date, p.status, p.pic_id
      FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date IS NOT NULL AND p.venue IS NOT NULL AND trim(p.venue) <> ''
       AND p.start_date >= ${minusDays(FROM, 60)}`;
  const fairById = new Map(fairs.map((f) => [Number(f.id), f]));
  const linkedIds = [...new Set(orders.map((o) => o.project_id).filter((v) => v != null).map(Number))].filter((id) => !fairById.has(id));
  if (linkedIds.length) {
    for (const f of await sql`SELECT p.id, p.name, p.venue, p.organizer, p.brand, p.start_date, p.end_date, p.status, p.pic_id FROM public.projects p WHERE p.id IN ${sql(linkedIds)}`) {
      fairById.set(Number(f.id), f);
    }
  }
  const fairIds = fairs.map((f) => Number(f.id));
  const attendees = fairIds.length ? await sql`
    SELECT a.project_id, a.sales_rep_id, sr.user_id, sr.name
      FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id
     WHERE a.project_id IN ${sql(fairIds)}` : [];

  /* Who stands at which booth: Sales Attending rows, plus the PIC. */
  const boothsOfUser = new Map();
  const add = (uid, f) => { if (uid == null || !f) return; const k = Number(uid); if (!boothsOfUser.has(k)) boothsOfUser.set(k, []); boothsOfUser.get(k).push(f); };
  for (const a of attendees) add(a.user_id, fairById.get(Number(a.project_id)));
  for (const f of fairs) add(f.pic_id, f);
  const attendeeCount = new Map();
  for (const a of attendees) attendeeCount.set(Number(a.project_id), (attendeeCount.get(Number(a.project_id)) ?? 0) + 1);

  /* 1. Fairs since FROM: does anybody stand on them? */
  const recent = fairs.filter((f) => day(f.start_date) >= FROM).sort((a, b) => day(a.start_date).localeCompare(day(b.start_date)));
  const withTeam = recent.filter((f) => (attendeeCount.get(Number(f.id)) ?? 0) > 0);
  console.log(`company ${CO}: booths starting ${FROM} onward: ${recent.length}; with someone on Sales Attending: ${withTeam.length}`);
  for (const f of recent) console.log(`  ${label(f)} | attending ${attendeeCount.get(Number(f.id)) ?? 0}${f.pic_id != null ? ' | PIC user ' + f.pic_id : ''}`);

  /* 2. Each order against its salesperson's assignment. */
  const tally = {};
  const bump = (k, sen) => { tally[k] ??= [0, 0]; tally[k][0] += 1; tally[k][1] += rm(sen); };
  const lines = [];
  for (const o of orders) {
    const d = day(o.so_date);
    const linked = o.project_id != null ? fairById.get(Number(o.project_id)) ?? { id: o.project_id, venue: '?', organizer: '?', start_date: '', end_date: '' } : null;
    const uid = o.sp_user_id != null ? Number(o.sp_user_id) : null;
    const assigned = uid == null ? [] : (boothsOfUser.get(uid) ?? []).filter((f) => inWindow(f, d));
    let pick = null;
    let why = uid == null ? 'salesperson has no user' : 'no assignment in 28 days';
    if (assigned.length) {
      /* Nearest event: latest start, then shortest. */
      const events = [...new Map(assigned.map((f) => [eventKey(f), f])).values()]
        .sort((a, b) => day(b.start_date).localeCompare(day(a.start_date)) || (day(a.end_date) || '9').localeCompare(day(b.end_date) || '9'));
      const ev = eventKey(events[0]);
      const booths = fairs.filter((f) => eventKey(f) === ev).sort((a, b) => Number(a.id) - Number(b.id));
      const brand = norm(o.branding);
      const byBrand = brand ? booths.filter((f) => norm(f.brand) === brand) : [];
      const own = assigned.filter((f) => eventKey(f) === ev).sort((a, b) => Number(a.id) - Number(b.id));
      pick = byBrand[0] ?? own[0] ?? null;
      why = byBrand[0] ? 'brand booth' : 'own booth';
      if (events.length > 1) why += ` (nearest of ${events.length})`;
    }
    const linkedNow = linked != null;
    let verdict;
    if (!pick) verdict = linkedNow ? 'linked | assignment: none' : 'NOT linked | assignment: none';
    else if (!linkedNow) verdict = 'NOT linked | assignment would link';
    else if (Number(linked.id) === Number(pick.id)) verdict = 'linked | assignment agrees (same booth)';
    else if (eventKey(linked) === eventKey(pick)) verdict = 'linked | same fair, other booth';
    else verdict = 'linked | assignment says another fair';
    const after = d >= '2026-09-26' ? 'from 26/09' : 'before 26/09';
    bump(`${after} | ${verdict}`, o.local_total_sen);
    if (!linkedNow || verdict.includes('another fair')) {
      lines.push([o.fair_match ?? 'NULL', o.doc_no, d, viaOf.get(o.doc_no) ?? '?', o.venue_source ?? '-', o.sp_name ?? '?', o.venue ?? '—', o.branding ?? '—', rm(o.local_total_sen),
        `now ${label(linked)}`, `assignment ${pick ? label(pick) + ' [' + why + ']' : why}`].join(' | '));
    }
  }
  console.log('\nby order date | current link | what the salesperson\'s assignment says — n | RM');
  for (const k of Object.keys(tally).sort()) console.log(`  ${k} — ${tally[k][0]} | ${tally[k][1].toLocaleString('en-MY')}`);

  /* 3. How unlinked orders since 26/09 (fair compulsory) were entered. */
  const via = {};
  for (const o of orders) {
    if (o.project_id != null || day(o.so_date) < '2026-09-26') continue;
    const k = `${viaOf.get(o.doc_no) ?? '?'} | ${o.fair_match ?? 'NULL'}`;
    via[k] = (via[k] ?? 0) + 1;
  }
  console.log('\nunlinked since 26/09 by how they were entered (audit source/status) | fair_match — n');
  for (const k of Object.keys(via).sort()) console.log(`  ${k} — ${via[k]}`);

  console.log('\nunlinked orders + orders whose assignment names another fair:');
  for (const l of lines) console.log('  ' + l);
} finally {
  await sql.end();
}
