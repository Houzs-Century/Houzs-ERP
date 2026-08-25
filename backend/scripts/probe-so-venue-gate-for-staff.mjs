#!/usr/bin/env node
// READ-ONLY. SELECT only — no DDL, no writes, no transaction.
//
// WHY: "Order placement failed: A venue is required before this order can be
// confirmed." blocks a salesperson from placing ANY order from the 2990 POS.
// The confirm gate (scm/lib/so-confirm-gate.ts, rule 3) refuses when BOTH the
// venue TEXT and the venue_id are blank. The create path fills those from FOUR
// sources, in this order (routes/mfg-sales-orders.ts):
//
//   A. body.venue / body.venueId sent by the client        -> MANUAL
//   B. the stamped salesperson's scm.staff.venue_id, resolved against
//      scm.venues for the display name                     -> SHOWROOM
//   C. the caller's own scm.staff.venue_id, when their scm.staff.role is
//      sales / sales_executive / outlet_manager            -> SHOWROOM
//   D. venue-binding (scm/lib/venue-binding.ts): PMS project period first,
//      then scm.staff.showroom_warehouse_id -> scm.warehouses.venue_name,
//      then NOTHING                                        -> PMS | SHOWROOM
//
// Only D can be seen from the database alone for a client that sends nothing.
// This probe prints EVERY input of B, C and D for the named staff, replays the
// pure resolver, and states which of the four the order would have taken — so
// "the venue is not hung anywhere" stops being a guess.
//
// PUBLIC REPO — workflow logs are public. Staff NAMES are printed because that
// is the question being asked and because check-venue-showroom-parking.mjs
// already prints them; nothing else identifying (email, phone, PIN, customer)
// is read by this script.
//
//   STAFF=Adrian node scripts/probe-so-venue-gate-for-staff.mjs
//   STAFF=Adrian,Jason COMPANY=1 node scripts/probe-so-venue-gate-for-staff.mjs
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(2); }
const NAMES = (process.env.STAFF || '').split(',').map((s) => s.trim()).filter(Boolean);
const CO = (process.env.COMPANY || '').trim() ? Number(process.env.COMPANY.trim()) : null;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const blank = (v) => v == null || String(v).trim() === '';
const show = (v) => (blank(v) ? '(EMPTY)' : JSON.stringify(String(v)));

/** Today's MYT calendar date — the same shift todayMyt() does (lib/my-time.ts). */
const todayMyt = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

async function cols(schema, table) {
  const r = await sql`SELECT column_name FROM information_schema.columns
                       WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}

/** periodContains() from lib/venue-binding.ts, verbatim in behaviour. */
const periodContains = (c, date) => {
  if (!c.start_date) return false;
  const s = String(c.start_date).slice(0, 10);
  const e = c.end_date ? String(c.end_date).slice(0, 10) : null;
  return date >= s && (e === null || date <= e);
};

async function main() {
  const date = todayMyt();
  note('=== SO VENUE GATE — why "A venue is required" fires (READ-ONLY) ===');
  note(`MYT date used for the PMS period test: ${date}`);
  note('');

  // -- 1. The showroom masters — source D's second rule ----------------------
  const whCols = await cols('scm', 'warehouses');
  const hasType = whCols.has('type');
  const rooms = await sql.unsafe(
    'SELECT id, company_id, code, name, is_showroom, venue_name'
    + (whCols.has('is_active') ? ', is_active' : '')
    + (hasType ? ', type::text AS type' : '')
    + ' FROM scm.warehouses WHERE is_showroom = true'
    + (hasType ? " OR type::text = 'showroom'" : '')
    + ' ORDER BY company_id, code');
  note(`--- 1. SHOWROOMS (scm.warehouses) — ${rooms.length} row(s) ---`);
  note(`  ${pad('co', 3)} ${pad('code', 16)} ${pad('name', 26)} ${pad('is_showroom', 12)} ${pad('active', 7)} venue_name`);
  for (const r of rooms) {
    note(`  ${pad(r.company_id, 3)} ${pad(r.code, 16)} ${pad(r.name, 26)} ${pad(r.is_showroom, 12)} ${pad(r.is_active ?? '-', 7)} ${show(r.venue_name)}`);
  }
  const roomsNoVenue = rooms.filter((r) => blank(r.venue_name));
  const roomsNotFlagged = rooms.filter((r) => r.is_showroom !== true);
  note(`  showrooms with NO venue_name (cannot supply a venue): ${roomsNoVenue.length}`);
  note(`  type='showroom' but is_showroom=false (resolver ignores them, mig 0186): ${roomsNotFlagged.length}`);
  note('');

  // -- 2. scm.venues — source B/C's lookup table -----------------------------
  const vExists = (await sql`SELECT to_regclass('scm.venues') AS t`)[0].t;
  if (!vExists) {
    note('--- 2. scm.venues — TABLE DOES NOT EXIST. Sources B and C can never resolve a name.');
  } else {
    const vn = await sql`SELECT count(*)::int AS n FROM scm.venues`;
    note(`--- 2. scm.venues (staff.venue_id -> name, sources B and C): ${vn[0].n} row(s) ---`);
    if (vn[0].n > 0 && vn[0].n <= 40) {
      const vr = await sql`SELECT id, name FROM scm.venues ORDER BY name`;
      for (const v of vr) note(`     ${v.id}  ${show(v.name)}`);
    }
  }
  note('');

  // -- 3. public.project_venues — the master the venue pickers list ----------
  const pv = await sql`
    SELECT company_id, count(*)::int AS n,
           count(*) FILTER (WHERE active = 1)::int AS active
      FROM public.project_venues GROUP BY company_id ORDER BY company_id`;
  note('--- 3. public.project_venues (the venue MASTER the pickers list) ---');
  for (const r of pv) note(`     company ${r.company_id}: ${r.n} row(s), ${r.active} active`);
  note('');

  // -- 4. staff parking, blast radius ---------------------------------------
  const stCols = await cols('scm', 'staff');
  const parkSel = ['id', 'name', 'user_id', 'showroom_warehouse_id']
    .concat(['company_id', 'active', 'role', 'venue_id', 'staff_code'].filter((c) => stCols.has(c)));
  const blast = await sql.unsafe(
    'SELECT count(*)::int AS total,'
    + ' count(*) FILTER (WHERE showroom_warehouse_id IS NULL)::int AS unparked'
    + (stCols.has('venue_id') ? ', count(*) FILTER (WHERE venue_id IS NULL)::int AS no_home_venue' : '')
    + ' FROM scm.staff ' + (stCols.has('active') ? 'WHERE active = true' : ''));
  const b = blast[0];
  note(`--- 4. BLAST RADIUS (${stCols.has('active') ? 'active ' : ''}scm.staff) ---`);
  note(`     staff rows                          : ${b.total}`);
  note(`     NOT parked under any showroom       : ${b.unparked}`);
  if (b.no_home_venue != null) note(`     with NO staff.venue_id (home venue) : ${b.no_home_venue}`);
  const parkedNoVenue = await sql`
    SELECT count(*)::int AS n FROM scm.staff st
      JOIN scm.warehouses w ON w.id = st.showroom_warehouse_id
     WHERE w.is_showroom IS NOT TRUE OR w.venue_name IS NULL OR btrim(w.venue_name) = ''`;
  note(`     parked, but that showroom supplies NO venue: ${parkedNoVenue[0].n}`);
  note('');

  if (!NAMES.length) { note('STAFF not set — masters only. Re-run with STAFF=<name fragment>.'); return; }

  const soCols = await cols('scm', 'mfg_sales_orders');
  const vs = soCols.has('venue_source') ? ', venue_source' : '';

  // -- 5. Per-person replay of the whole chain ------------------------------
  for (const nm of NAMES) {
    const like = `%${nm.toLowerCase()}%`;
    const staff = await sql.unsafe(
      'SELECT ' + parkSel.map((c) => `"${c}"`).join(', ') + ' FROM scm.staff'
      + ' WHERE lower(name) LIKE $1'
      + (CO != null && stCols.has('company_id') ? ` AND company_id = ${CO}` : '')
      + ' ORDER BY name', [like]);
    note(`=== 5. "${nm}" — ${staff.length} scm.staff row(s) ===`);
    if (!staff.length) { note('    NO STAFF ROW MATCHES THAT NAME.'); note(''); continue; }

    for (const s of staff) {
      note(`  --- ${s.name}  staff.id=${s.id}${s.staff_code ? `  code=${s.staff_code}` : ''} ---`);
      note(`      company_id=${s.company_id ?? '-'}  user_id=${s.user_id ?? '(NULL — no Houzs login link)'}  role=${s.role ?? '-'}  active=${s.active ?? '-'}`);

      // SOURCE B/C — staff.venue_id
      if ('venue_id' in s) {
        if (blank(s.venue_id)) {
          note('      SOURCE B/C  staff.venue_id = (NULL)  -> no home venue');
        } else {
          const vr = vExists ? await sql`SELECT name FROM scm.venues WHERE id = ${s.venue_id}` : [];
          note(`      SOURCE B/C  staff.venue_id = ${s.venue_id} -> scm.venues name = ${vr.length ? show(vr[0].name) : '(NO SUCH ROW)'}`);
          note('                  NOTE: a non-null venue_id ALONE satisfies the confirm gate (it checks venue OR venueId).');
        }
      }

      // SOURCE D2 — showroom parking
      let showroomVenue = null;
      if (blank(s.showroom_warehouse_id)) {
        note('      SOURCE D2   showroom_warehouse_id = (NULL) -> NOT PARKED under any showroom');
      } else {
        const wr = await sql`SELECT id, company_id, code, name, is_showroom, venue_name
                               FROM scm.warehouses WHERE id = ${s.showroom_warehouse_id}`;
        if (!wr.length) {
          note(`      SOURCE D2   parked under ${s.showroom_warehouse_id} -> WAREHOUSE ROW MISSING`);
        } else {
          const w = wr[0];
          note(`      SOURCE D2   parked under ${w.code} "${w.name}" (company ${w.company_id})`);
          note(`                  is_showroom=${w.is_showroom}  venue_name=${show(w.venue_name)}`);
          if (w.is_showroom !== true) note('                  -> RESOLVES TO NOTHING: is_showroom is not true (re-checked at resolve time).');
          else if (blank(w.venue_name)) note('                  -> RESOLVES TO NOTHING: the showroom has no venue_name.');
          else showroomVenue = String(w.venue_name).trim();
        }
      }

      // SOURCE D1 — PMS candidates (the loader's exact SQL)
      let pmsWinner = null;
      if (s.user_id == null) {
        note('      SOURCE D1   skipped — no user_id, the PMS query keys on public.users.id');
      } else {
        const cands = await sql`
          SELECT p.id, p.name, p.venue, p.start_date, p.end_date
            FROM projects p
           WHERE p.venue IS NOT NULL AND p.venue <> ''
             AND ( p.pic_id = ${s.user_id}
                OR EXISTS (SELECT 1 FROM project_sales_attendees psa
                             JOIN sales_reps sr ON sr.id = psa.sales_rep_id
                            WHERE psa.project_id = p.id AND sr.user_id = ${s.user_id}) )`;
        const inPeriod = cands.filter((c) => periodContains(c, date));
        note(`      SOURCE D1   PMS projects with a venue attached to this person: ${cands.length}, of which running on ${date}: ${inPeriod.length}`);
        for (const c of cands) {
          note(`                  #${c.id} ${pad(c.name, 24)} venue=${show(c.venue)} ${c.start_date ?? '(no start)'} -> ${c.end_date ?? '(open)'}${periodContains(c, date) ? '   <= RUNNING' : ''}`);
        }
        if (inPeriod.length) {
          inPeriod.sort((a, x) => String(a.start_date).localeCompare(String(x.start_date)) || Number(a.id) - Number(x.id));
          pmsWinner = inPeriod[inPeriod.length - 1];
        }
      }

      // VERDICT
      const resolved = pmsWinner ? { src: 'PMS', v: String(pmsWinner.venue).trim() }
        : showroomVenue ? { src: 'SHOWROOM', v: showroomVenue }
          : null;
      const homeVenueSaves = 'venue_id' in s && !blank(s.venue_id);
      note('');
      if (resolved) {
        note(`      VERDICT: venue-binding resolves ${show(resolved.v)} via ${resolved.src}. The gate should PASS with no client input.`);
      } else if (homeVenueSaves) {
        note('      VERDICT: venue-binding resolves NOTHING, but staff.venue_id is set, which alone satisfies the gate.');
      } else {
        note('      VERDICT: NOTHING resolves. staff.venue_id is null, no PMS project is running, and the showroom');
        note('               parking supplies no venue. Unless the CLIENT sends a venue, every confirmed order this');
        note('               person places is refused with "A venue is required before this order can be confirmed."');
      }

      const recent = await sql.unsafe(
        `SELECT doc_no, company_id, status::text AS status, venue, venue_id${vs}, created_at`
        + ' FROM scm.mfg_sales_orders WHERE salesperson_id = $1'
        + ' ORDER BY created_at DESC LIMIT 12', [s.id]);
      note(`      last ${recent.length} order(s) by this person:`);
      for (const r of recent) {
        note(`        ${pad(r.doc_no, 22)} co=${pad(r.company_id, 2)} ${pad(r.status, 10)} venue=${pad(show(r.venue), 22)} venue_id=${pad(r.venue_id ?? '-', 12)} src=${pad(r.venue_source ?? '-', 9)} ${String(r.created_at).slice(0, 10)}`);
      }
      note('');
    }
  }

  // -- 6. Which fairs are RUNNING today, and who can resolve a venue at all ---
  note('--- 6. PMS projects with a venue, running TODAY ---');
  const running = await sql`
    SELECT p.id, p.name, p.venue, p.start_date, p.end_date, p.pic_id, p.company_id,
           (SELECT count(*)::int FROM project_sales_attendees psa WHERE psa.project_id = p.id) AS attendees
      FROM projects p
     WHERE p.venue IS NOT NULL AND p.venue <> ''
       AND p.start_date IS NOT NULL AND p.start_date::text <= ${date}
       AND (p.end_date IS NULL OR p.end_date::text >= ${date})
     ORDER BY p.start_date`;
  note(`     ${running.length} project(s) running on ${date}`);
  for (const r of running) {
    note(`       #${r.id} co=${r.company_id ?? '-'} ${pad(r.name, 30)} venue=${show(r.venue)} ${r.start_date} -> ${r.end_date ?? '(open)'} pic=${r.pic_id ?? '-'} attendees=${r.attendees}`);
  }

  const recentlyEnded = await sql`
    SELECT p.id, p.name, p.venue, p.start_date, p.end_date
      FROM projects p
     WHERE p.venue IS NOT NULL AND p.venue <> '' AND p.end_date IS NOT NULL
       AND p.end_date::text < ${date}
       AND p.end_date::text >= (${date}::date - INTERVAL '30 days')::text
     ORDER BY p.end_date DESC`;
  note(`     ${recentlyEnded.length} project(s) with a venue that ENDED in the last 30 days`);
  for (const r of recentlyEnded) {
    note(`       #${r.id} ${pad(r.name, 30)} venue=${show(r.venue)} ended ${r.end_date}`);
  }
  note('');

  // Per-person: can ANYTHING resolve a venue today? This is the blocked count.
  const everyone = await sql.unsafe(
    'SELECT st.id, st.name, st.role, st.user_id, st.venue_id, st.showroom_warehouse_id,'
    + ' w.venue_name AS showroom_venue, w.is_showroom'
    + ' FROM scm.staff st LEFT JOIN scm.warehouses w ON w.id = st.showroom_warehouse_id'
    + (stCols.has('active') ? ' WHERE st.active = true' : '')
    + ' ORDER BY st.name');
  const runningIds = running.map((r) => Number(r.id));
  let onRunningFair = new Set();
  if (runningIds.length) {
    const teamed = await sql`
      SELECT DISTINCT sr.user_id FROM project_sales_attendees psa
        JOIN sales_reps sr ON sr.id = psa.sales_rep_id
       WHERE psa.project_id = ANY(${runningIds}) AND sr.user_id IS NOT NULL`;
    onRunningFair = new Set(teamed.map((r) => Number(r.user_id)));
    for (const r of running) if (r.pic_id != null) onRunningFair.add(Number(r.pic_id));
  }
  let blocked = 0; const blockedSales = [];
  for (const s of everyone) {
    const viaPms = s.user_id != null && onRunningFair.has(Number(s.user_id));
    const viaShowroom = s.is_showroom === true && !blank(s.showroom_venue);
    const viaHome = !blank(s.venue_id);
    if (!viaPms && !viaShowroom && !viaHome) {
      blocked += 1;
      if (String(s.role ?? '').toLowerCase().includes('sales')) blockedSales.push(s.name);
    }
  }
  note(`--- 7. WHO CANNOT PLACE A CONFIRMED ORDER TODAY (no venue resolves) ---`);
  note(`     active staff rows checked          : ${everyone.length}`);
  note(`     no venue resolves from ANY source  : ${blocked}`);
  note(`     of those, role contains "sales"    : ${blockedSales.length}`);
  note(`     ${blockedSales.slice(0, 60).join(', ')}`);
  note('');

  note('=== END — read-only, nothing written. ===');
}

main().then(() => sql.end()).catch((e) => {
  console.error('VENUE_GATE_PROBE_FAIL', e?.message ?? e);
  process.exit(1);
});
