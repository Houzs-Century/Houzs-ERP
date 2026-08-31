#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-so-venue-binding — why is this order's Venue empty?
//
// THE QUESTION (owner, 2026-09-01): 「为什么我的 Venue 又不见了？」 — two brand-new
// 2990 sales orders showing "—" in the Venue column.
//
// THE RULE IT IS TESTING AGAINST (routes/mfg-sales-orders.ts, the create path):
//   1. a venue the CLIENT typed wins, and is marked MANUAL;
//   2. else the salesperson's venue_id is resolved to its name (SHOWROOM);
//   3. else NULL — deliberately. "No company default, no first-venue-in-the-list,
//      no `?? ''`. An unresolvable venue stays NULL, because venue feeds
//      exhibition P&L and commission and a guessed venue is a wrong profit
//      figure paid to a real person."
//
// So an empty Venue is never a lost value: it is rule 3, and the question is
// always WHICH INPUT WAS ABSENT. This prints exactly that, for one order or for
// a whole day's worth.
//
// NAMES ARE NOT PRINTED. This repository's Actions logs are public, so a
// salesperson is a role and a set of booleans here, never a name.
//
// NOTHING IS WRITTEN. SELECTs only.
//
//   DATABASE_URL   required
//   COMPANY_ID     default 1
//   DOC_NO         one order (optional)
//   SINCE          YYYY-MM-DD — scan every order written on/after this instead
//
// RE-RUN: idempotent and side-effect free.
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const DOC = (process.env.DOC_NO ?? '').trim();
const SINCE = (process.env.SINCE ?? '').trim();
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  if (!DOC && !SINCE) { console.error('DOC_NO or SINCE required'); process.exit(2); }
  log(`company ${CO}${DOC ? `, document ${DOC}` : `, orders written on/after ${SINCE}`}`);

  const orders = await sql`
    SELECT h.doc_no, h.so_date, h.venue, h.venue_id, h.venue_source,
           h.salesperson_id, h.project_id
      FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${CO}
       ${DOC ? sql`AND h.doc_no = ${DOC}` : sql`AND h.so_date >= ${SINCE}::date`}
     ORDER BY h.so_date DESC, h.doc_no
     LIMIT 40`;

  if (!orders.length) { log('no such order in this company.'); await sql.end(); return; }

  const withVenue = orders.filter((o) => String(o.venue ?? '').trim() !== '');
  log(`orders examined: ${orders.length}; carrying a Venue: ${withVenue.length}; EMPTY: ${orders.length - withVenue.length}`);
  log('');

  const staffIds = [...new Set(orders.map((o) => o.salesperson_id).filter(Boolean))];
  const staff = staffIds.length ? await sql`
    SELECT s.id, s.role::text AS role, s.venue_id, s.showroom_warehouse_id,
           (v.id IS NOT NULL) AS venue_master_exists, v.name AS venue_name
      FROM scm.staff s
      LEFT JOIN scm.venues v ON v.id = s.venue_id
     WHERE s.id = ANY(${staffIds})` : [];
  const byStaff = new Map(staff.map((s) => [String(s.id), s]));

  for (const o of orders.slice(0, 12)) {
    const s = byStaff.get(String(o.salesperson_id));
    log(`${o.doc_no}  ${String(o.so_date).slice(0, 10)}`);
    log(`   venue: ${o.venue ? `"${o.venue}"` : 'EMPTY'}   venue_id: ${o.venue_id ? 'set' : 'none'}`
      + `   source: ${o.venue_source ?? 'none'}   project: ${o.project_id ? 'linked' : 'none'}`);
    if (!o.salesperson_id) { log('   salesperson: NONE on the order — rule 2 has nothing to resolve from'); continue; }
    if (!s) { log('   salesperson: set, but no scm.staff row found for it'); continue; }
    log(`   salesperson: role='${s.role}'  home venue on their staff row: ${s.venue_id ? (s.venue_master_exists ? `set ("${s.venue_name}")` : 'set but NOT in the venue master') : 'NONE'}`
      + `  parked under a showroom: ${s.showroom_warehouse_id ? 'yes' : 'no'}`);
  }
  if (orders.length > 12) log(`... and ${orders.length - 12} more`);

  log('');
  log('READ IT THIS WAY: an empty Venue is not a lost value — the create path refuses');
  log('to guess one. It is either (a) nobody typed one AND (b) the salesperson has no');
  log('home venue and is parked under no showroom, or the order has no salesperson at');
  log('all. The fix is on the Members page, not in the order.');

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
