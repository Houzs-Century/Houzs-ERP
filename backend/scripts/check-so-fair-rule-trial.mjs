#!/usr/bin/env node
// check-so-fair-rule-trial.mjs — READ-ONLY. Trial of a fair-link rule that uses
// the order's PLACE and the salesperson's PMS assignment together, measured
// against the links orders already carry.
//
// WHY. check-so-fair-assignments.mjs (2026-10-16) showed the assignment alone
// misplaces back-keyed orders: a rep on a fair every weekend keys a week's
// orders later, and "their nearest fair" is then the wrong one. The place on the
// order narrows it first. The rule tried here, per order (venue V, date D,
// brand B, salesperson S):
//   1. events at V overlapping the 28 days up to D (the window the picker uses);
//   2. more than one → those S stood at (Sales Attending / PIC); still more than
//      one, or none → the nearest (owner 2026-10-16: 「可以」);
//   3. booth → B's booth; no booth for B → S's own booth there (owner: 「sales
//      person 站的 booth」); else the event's only booth; else undecided.
// Also: when S stood at exactly one event in the window, is that the order's
// event? (would pre-filling the picker from the assignment be right?)
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-26).
//   npx tsx scripts/check-so-fair-rule-trial.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-26');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const rm = (sen) => Math.round(Number(sen ?? 0) / 100);
const minusDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10); };
const eventKey = (f) => `${norm(f.venue)}|${norm(f.organizer)}|${day(f.start_date)}|${day(f.end_date)}`;
const label = (f) => (f ? `${f.id}:${f.brand ?? '?'}@${f.venue}/${f.organizer ?? '-'}/${day(f.start_date)}..${day(f.end_date)}` : '—');
const inWindow = (f, d) => day(f.start_date) <= d && (day(f.end_date) || day(f.start_date)) >= minusDays(d, 28);
const nearestFirst = (a, b) => day(b.start_date).localeCompare(day(a.start_date)) || (day(a.end_date) || '9').localeCompare(day(b.end_date) || '9') || Number(a.id) - Number(b.id);

try {
  const orders = await sql`
    SELECT so.doc_no, so.so_date, so.venue, so.branding, so.fair_match, so.project_id, so.local_total_sen,
           st.name AS sp_name, st.user_id AS sp_user_id
      FROM scm.mfg_sales_orders so LEFT JOIN scm.staff st ON st.id = so.salesperson_id
     WHERE so.company_id = ${CO} AND so.so_date >= ${FROM} AND so.status::text NOT IN ('CANCELLED', 'DRAFT')
     ORDER BY so.so_date, so.doc_no`;
  const fairs = await sql`
    SELECT p.id, p.venue, p.organizer, p.brand, p.start_date, p.end_date, p.pic_id
      FROM public.projects p
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date IS NOT NULL AND p.venue IS NOT NULL AND trim(p.venue) <> '' AND p.organizer IS NOT NULL AND trim(p.organizer) <> ''
       AND p.start_date >= ${minusDays(FROM, 60)}`;
  const byId = new Map(fairs.map((f) => [Number(f.id), f]));
  const attendees = await sql`
    SELECT a.project_id, sr.user_id FROM public.project_sales_attendees a JOIN public.sales_reps sr ON sr.id = a.sales_rep_id
     WHERE a.project_id IN ${sql(fairs.map((f) => Number(f.id)))}`;
  const stoodAt = new Map(); // user id → Set(project id)
  const mark = (uid, pid) => { if (uid == null) return; const k = Number(uid); if (!stoodAt.has(k)) stoodAt.set(k, new Set()); stoodAt.get(k).add(Number(pid)); };
  for (const a of attendees) mark(a.user_id, a.project_id);
  for (const f of fairs) mark(f.pic_id, f.id);

  const tally = {};
  const bump = (k, sen) => { tally[k] ??= [0, 0]; tally[k][0] += 1; tally[k][1] += rm(sen); };
  const prefill = {};
  const misses = [];
  for (const o of orders) {
    const d = day(o.so_date);
    const uid = o.sp_user_id != null ? Number(o.sp_user_id) : null;
    const mine = uid != null ? stoodAt.get(uid) ?? new Set() : new Set();
    const linked = o.project_id != null ? byId.get(Number(o.project_id)) ?? null : null;

    /* Would pre-filling the picker from the assignment have been right? */
    const myEvents = [...new Map(fairs.filter((f) => mine.has(Number(f.id)) && inWindow(f, d)).map((f) => [eventKey(f), f])).values()];
    const pk = myEvents.length === 0 ? 'rep on no fair in 28 days' : myEvents.length === 1 ? 'rep on exactly 1 fair' : `rep on ${myEvents.length >= 3 ? '3+' : '2'} fairs`;
    const pv = linked ? (myEvents.some((e) => eventKey(e) === eventKey(linked)) ? (myEvents.length === 1 ? 'that fair IS the order\'s' : 'order\'s fair among them') : 'order\'s fair NOT among them') : 'order not linked';
    prefill[`${pk} | ${pv}`] = (prefill[`${pk} | ${pv}`] ?? 0) + 1;

    /* The trial rule. */
    let pick = null;
    let why;
    const atVenue = fairs.filter((f) => norm(f.venue) === norm(o.venue) && inWindow(f, d));
    const events = [...new Map(atVenue.map((f) => [eventKey(f), f])).values()].sort(nearestFirst);
    if (!o.venue) why = 'no venue';
    else if (events.length === 0) why = 'no fair at this place in 28 days';
    else {
      let chosen = events;
      if (events.length > 1) {
        const stood = events.filter((e) => atVenue.some((f) => eventKey(f) === eventKey(e) && mine.has(Number(f.id))));
        chosen = stood.length >= 1 ? stood : events;
      }
      const ev = eventKey(chosen[0]);
      const booths = atVenue.filter((f) => eventKey(f) === ev).sort((a, b) => Number(a.id) - Number(b.id));
      const brand = norm(o.branding);
      const own = booths.filter((f) => mine.has(Number(f.id)));
      pick = (brand && booths.find((f) => norm(f.brand) === brand)) || own[0] || (booths.length === 1 ? booths[0] : null);
      why = pick ? (brand && norm(pick.brand) === brand ? 'brand booth' : own[0] && pick === own[0] ? 'own booth' : 'only booth')
        : `undecided booth (${booths.map((f) => f.brand).join('/')})`;
      if (events.length > 1) why += chosen.length < events.length ? `, rep stood at 1 of ${events.length}` : `, nearest of ${events.length}`;
    }
    let verdict;
    if (linked && pick) verdict = Number(linked.id) === Number(pick.id) ? 'linked | rule agrees' : eventKey(linked) === eventKey(pick) ? 'linked | rule: same fair, other booth' : 'linked | rule: OTHER fair';
    else if (linked) verdict = 'linked | rule: nothing';
    else if (pick) verdict = 'NOT linked | rule links';
    else verdict = 'NOT linked | rule: nothing';
    bump(verdict, o.local_total_sen);
    if (verdict !== 'linked | rule agrees') {
      misses.push([verdict, o.fair_match ?? 'NULL', o.doc_no, d, o.sp_name ?? '?', o.venue ?? '—', o.branding ?? '—', rm(o.local_total_sen),
        `now ${label(linked)}`, `rule ${pick ? label(pick) : '—'} [${why}]`].join(' | '));
    }
  }
  console.log(`company ${CO}, orders dated ${FROM} onward: ${orders.length}`);
  console.log('\ntrial rule (place → rep\'s fair → nearest; brand booth → own booth) vs the link now — n | RM');
  for (const k of Object.keys(tally).sort()) console.log(`  ${k} — ${tally[k][0]} | ${tally[k][1].toLocaleString('en-MY')}`);
  console.log('\nwould pre-filling the picker from the rep\'s assignment be right? — n');
  for (const k of Object.keys(prefill).sort()) console.log(`  ${k} — ${prefill[k]}`);
  console.log('\nevery order the rule does not simply agree with:');
  for (const l of misses.sort()) console.log('  ' + l);
} finally {
  await sql.end();
}
