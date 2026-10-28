#!/usr/bin/env node
/* READ-ONLY. Why does a fair sit in the SO picker's "Running now" group while
 * the Projects calendar shows nothing?
 *
 * Owner, 2026-09-19, looking at New Sales Order with `PAVILION BUKIT JALIL —
 * MEGAHOME` under Running now: 「why there is megahome pavillion bukit jalil,
 * but i didnt saw this event in calender, is that any error」.
 *
 * Owner rule: never ask him to run a query — build the check. Actions ->
 * "Fair picker vs calendar (read-only)" -> Run workflow; the answer is the log.
 *
 * WRITES NOTHING, on any path. SELECTs only, no DDL, no transaction. Exits 0 for
 * every legitimate answer including "the two agree everywhere" — a red job reads
 * as "the check broke", and the answer is the output. Non-zero is reserved for
 * an unreachable database.
 *
 * ── THE TWO RULES THIS COMPARES ────────────────────────────────────────────
 * Both surfaces read the SAME table, `public.projects`. They disagree on two
 * columns, and this probe measures how often that disagreement is visible.
 *
 *   END DATE
 *     calendar  `substr(COALESCE(p.end_date, p.start_date),1,10) >= from`
 *               (routes/projects.ts, GET /calendar/events) — a NULL end date is
 *               a ONE-DAY event on its start date.
 *     picker    `periodContains`: `if (row.endDate && row.endDate < date) return
 *               false; return true` (scm/lib/fair-options.ts) — a NULL end date
 *               NEVER ends, so the fair is "Running now" for ever.
 *
 *   ARCHIVED
 *     calendar  `WHERE p.archived_at IS NULL`.
 *     picker    `LIVE_FAIR` (scm/lib/fair-binding.ts) does not mention
 *               `archived_at` at all.
 *
 * Everything else the picker checks is STRICTER than the calendar (it drops
 * cancelled rows, rows with no venue and rows with no organizer), so a row the
 * calendar shows and the picker hides is expected and is not reported here.
 *
 * ── WHAT IT PRINTS ─────────────────────────────────────────────────────────
 *   0. Which database answered, so the output is evidence and not a claim.
 *   1. Every project at the named VENUE, with both verdicts on each row.
 *   2. Every row the picker calls "Running now" today, marked with whether the
 *      calendar would draw it today.
 *   3. The census: how many of those the calendar does not draw, by cause.
 *
 * RE-RUN: safe and identical — it is a read. Nothing is cached or stamped.
 */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const CO = Number(process.env.COMPANY || 1);
/* Default is the row the owner pointed at. Any substring works — the match is
   case-insensitive and collapses runs of whitespace, because PMS venues were
   typed by hand for years before the venue master existed. */
const VENUE = (process.env.VENUE || 'PAVILION BUKIT JALIL').trim();

/** Today as a MALAYSIAN calendar date. The runner is UTC and MYT is UTC+8, so
 *  `new Date().toISOString()` is yesterday here until 08:00 local — the exact
 *  off-by-one both surfaces take pains to avoid. */
function todayMyt() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

const TODAY = (process.env.AS_OF || todayMyt()).slice(0, 10);
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const line = (m) => console.log(m);
const rule = () => line('-'.repeat(78));

/** The picker's `periodContains`, in JS, on the values the DB returned. Kept as
 *  a copy rather than an import because this file must run with no build step;
 *  the assertion below is what stops the copy drifting. */
function pickerRunning(startDate, endDate, asOf) {
  if (!startDate) return false;
  if (startDate > asOf) return false;
  if (endDate && endDate < asOf) return false;
  return true;
}

/** The calendar's own WHERE, in JS. A NULL end date collapses to the start. */
function calendarShows(startDate, endDate, archivedAt, from, to) {
  if (archivedAt) return false;
  if (!startDate) return false;
  return startDate <= to && (endDate || startDate) >= from;
}

/* A checker that cannot match reports a clean run, so the two rules above are
   self-tested before anything is measured. A dead copy must refuse, not pass. */
function selfTest() {
  const fails = [];
  const eq = (got, want, what) => { if (got !== want) fails.push(what); };
  eq(pickerRunning('2026-01-05', null, '2026-09-19'), true, 'picker: null end runs for ever');
  eq(pickerRunning('2026-01-05', '2026-01-07', '2026-09-19'), false, 'picker: ended fair is over');
  eq(pickerRunning('2026-12-01', null, '2026-09-19'), false, 'picker: future fair is not running');
  eq(calendarShows('2026-01-05', null, null, '2026-09-01', '2026-09-30'), false, 'calendar: null end is one day');
  eq(calendarShows('2026-09-18', '2026-09-21', null, '2026-09-01', '2026-09-30'), true, 'calendar: live fair drawn');
  eq(calendarShows('2026-09-18', '2026-09-21', '2026-09-01', '2026-09-01', '2026-09-30'), false, 'calendar: archived hidden');
  if (fails.length) {
    console.error('REFUSING TO REPORT — the rule copies do not behave:');
    for (const f of fails) console.error(`  ${f}`);
    process.exit(2);
  }
}

const dash = (v) => (v == null || v === '' ? '-' : String(v));
const pad = (v, n) => dash(v).padEnd(n).slice(0, n);

function why(r, from, to) {
  const picker = pickerRunning(r.start_date, r.end_date, TODAY);
  const cal = calendarShows(r.start_date, r.end_date, r.archived_at, from, to);
  if (!picker || cal) return null;
  const causes = [];
  if (r.archived_at) causes.push('ARCHIVED');
  if (!r.end_date) causes.push('NO END DATE');
  if (!causes.length) causes.push('OUT OF WINDOW');
  return causes.join(' + ');
}

async function main() {
  selfTest();
  const from = TODAY.slice(0, 8) + '01';
  const y = Number(TODAY.slice(0, 4));
  const m = Number(TODAY.slice(5, 7));
  const to = `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;

  note(`as of ${TODAY} (MYT), company ${CO}, calendar month ${from}..${to}`);

  // ── 0. WHICH DATABASE ANSWERED ─────────────────────────────────────────
  rule();
  line('0. WHICH DATABASE ANSWERED');
  const ident = await sql`
    SELECT current_database() AS db,
           (SELECT count(*) FROM projects) AS projects,
           (SELECT count(*) FROM projects WHERE company_id = ${CO}) AS co_projects`;
  const id0 = ident[0];
  line(`   database=${id0.db}  projects=${id0.projects}  company ${CO}=${id0.co_projects}`);

  // ── 1. THE NAMED VENUE ─────────────────────────────────────────────────
  rule();
  line(`1. EVERY PROJECT AT A VENUE MATCHING "${VENUE}"`);
  const atVenue = await sql`
    SELECT p.id, p.code, p.company_id, p.venue, p.organizer, p.brand,
           p.start_date, p.end_date, p.status, p.archived_at,
           (SELECT et.slug FROM project_event_types et WHERE et.id = p.event_type_id) AS event_type
      FROM projects p
     WHERE regexp_replace(lower(coalesce(p.venue, '')), '\\s+', ' ', 'g')
           LIKE ${'%' + VENUE.toLowerCase().replace(/\s+/g, ' ') + '%'}
     ORDER BY p.start_date DESC NULLS LAST, p.id`;

  if (!atVenue.length) {
    line(`   NO PROJECT anywhere carries a venue matching "${VENUE}".`);
    line('   If the picker is offering it, it is NOT coming from this table — stop and say so.');
  } else {
    line(`   ${atVenue.length} row(s).`);
    line('');
    line(`   ${pad('id', 7)}${pad('co', 4)}${pad('organizer', 14)}${pad('brand', 12)}${pad('start', 12)}${pad('end', 12)}${pad('status', 11)}${pad('archived', 12)}${pad('type', 11)}`);
    for (const r of atVenue) {
      line(`   ${pad(r.id, 7)}${pad(r.company_id, 4)}${pad(r.organizer, 14)}${pad(r.brand, 12)}${pad(r.start_date, 12)}${pad(r.end_date, 12)}${pad(r.status, 11)}${pad(r.archived_at && String(r.archived_at).slice(0, 10), 12)}${pad(r.event_type, 11)}`);
    }
    line('');
    line('   VERDICT PER ROW — what each surface does with it today:');
    for (const r of atVenue) {
      const picker = pickerRunning(r.start_date, r.end_date, TODAY);
      const cal = calendarShows(r.start_date, r.end_date, r.archived_at, from, to);
      const cause = why(r, from, to);
      line(`     #${r.id} ${dash(r.venue)} — ${dash(r.organizer)} (${dash(r.brand)})`);
      line(`        picker: ${picker ? 'RUNNING NOW' : 'not running'}   calendar (${from}..${to}): ${cal ? 'drawn' : 'NOT DRAWN'}${cause ? `   cause: ${cause}` : ''}`);
    }
  }

  // ── 2. EVERY "RUNNING NOW" ROW TODAY ───────────────────────────────────
  rule();
  line(`2. EVERY ROW THE PICKER PUTS UNDER "RUNNING NOW" TODAY (company ${CO})`);
  /* The picker's own LIVE_FAIR filter, verbatim in spirit: a place, a start, and
     not cancelled. isPickableFair then also demands an organizer, which is
     applied below so a row missing one is reported rather than silently gone. */
  const live = await sql`
    SELECT p.id, p.venue, p.organizer, p.brand, p.start_date, p.end_date,
           p.status, p.archived_at
      FROM projects p
     WHERE p.company_id = ${CO}
       AND p.venue IS NOT NULL AND trim(p.venue) <> ''
       AND p.start_date IS NOT NULL
       AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date <= ${TODAY}
       AND (p.end_date IS NULL OR p.end_date >= ${TODAY})
     ORDER BY p.venue, p.organizer, p.id`;

  const pickable = live.filter((r) => String(r.organizer ?? '').trim() !== '');
  line(`   ${pickable.length} project row(s) survive the picker's filter and are "running" on ${TODAY}.`);
  line('   (the dropdown collapses these to one row per venue+organizer+period)');
  line('');
  line(`   ${pad('id', 7)}${pad('venue', 34)}${pad('organizer', 13)}${pad('start', 12)}${pad('end', 12)}${'calendar'}`);
  for (const r of pickable) {
    const cal = calendarShows(r.start_date, r.end_date, r.archived_at, from, to);
    const cause = why(r, from, to);
    line(`   ${pad(r.id, 7)}${pad(r.venue, 34)}${pad(r.organizer, 13)}${pad(r.start_date, 12)}${pad(r.end_date, 12)}${cal ? 'drawn' : `NOT DRAWN  <-- ${cause}`}`);
  }

  // ── 3. THE CENSUS ──────────────────────────────────────────────────────
  rule();
  line('3. THE CENSUS — rows the picker calls "Running now" that the calendar does not draw');
  const ghosts = pickable.filter((r) => why(r, from, to));
  if (!ghosts.length) {
    note('CLEAR: every fair the picker offers as running is also on the calendar today.');
  } else {
    const byCause = new Map();
    for (const r of ghosts) {
      const k = why(r, from, to);
      byCause.set(k, (byCause.get(k) ?? 0) + 1);
    }
    note(`${ghosts.length} of ${pickable.length} "Running now" rows are INVISIBLE on the calendar.`);
    for (const [cause, n] of [...byCause].sort((a, b) => b[1] - a[1])) {
      line(`   ${String(n).padStart(4)}  ${cause}`);
    }
    line('');
    line('   The oldest ones, which is what makes this visible to a person:');
    for (const r of [...ghosts].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))).slice(0, 15)) {
      line(`     started ${dash(r.start_date)}  #${r.id}  ${dash(r.venue)} — ${dash(r.organizer)}  [${why(r, from, to)}]`);
    }
  }

  // ── 4. HOW BIG IS THE NULL-END-DATE POPULATION ─────────────────────────
  rule();
  line('4. THE UNDERLYING POPULATION (company scope, all dates)');
  const pop = await sql`
    SELECT count(*)::int                                                        AS total,
           count(*) FILTER (WHERE p.end_date IS NULL)::int                      AS no_end,
           count(*) FILTER (WHERE p.archived_at IS NOT NULL)::int               AS archived,
           count(*) FILTER (WHERE p.end_date IS NULL
                              AND p.start_date <= ${TODAY})::int                AS no_end_past,
           count(*) FILTER (WHERE p.end_date IS NULL
                              AND p.start_date <= ${TODAY}
                              AND lower(coalesce(p.status,'')) <> 'cancelled'
                              AND p.organizer IS NOT NULL AND trim(p.organizer) <> ''
                              AND p.venue IS NOT NULL AND trim(p.venue) <> '')::int AS no_end_pickable
      FROM projects p
     WHERE p.company_id = ${CO}`;
  const p0 = pop[0];
  line(`   projects (company ${CO})                              ${p0.total}`);
  line(`   with NO end date                                     ${p0.no_end}`);
  line(`   with NO end date and already started                 ${p0.no_end_past}`);
  line(`   of those, pickable (venue+organizer, not cancelled)  ${p0.no_end_pickable}   <- permanently "Running now"`);
  line(`   archived                                             ${p0.archived}`);
  rule();
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error(`probe failed: ${e?.message ?? e}`);
    try { await sql.end(); } catch { /* already closed */ }
    process.exit(1);
  });
