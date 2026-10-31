#!/usr/bin/env node
/* Backfill setup / dismantle dates on CONFIRMED, UPCOMING projects that have
   none, so they appear on the Delivery Planning board.

   WHY. The board's project rows mirror a project's fleet window (setup /
   dismantle date) — a project with neither never shows. On 2026-10-31 every
   Nov (14) and Dec (21) CONFIRMED project had an event window (start/end) but no
   setup/dismantle date, so none of them reached the board. Going forward the
   on-confirm auto-fill (backend/src/services/project-fleet-dates.ts) handles this;
   this script covers the projects confirmed BEFORE that shipped.

   THE RULE, identical to the code path: setup = event start - 1 day, dismantle =
   event end + 1 day (the dominant convention in the data: ~253 projects at -1 and
   ~203 at +1). Fill-only — a date already set is never touched. Owner 2026-10-31:
   FUTURE only (event start today or later), so the board is not flooded with past
   windows. Confirmed + not archived only (a pending/cancelled project is not a
   fleet commitment).

   MODE=plan (default) writes nothing and prints COUNTS + a capped sample of
   (id, code, dates) — the repo is public, so no names/venues are logged. MODE=apply
   needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", sets the dates in one statement, then
   re-reads on a FRESH connection and asserts the shape: no targeted row is left
   without the date its event window implies.

   RE-RUN: inert. The WHERE only matches rows still missing a date within the
   confirmed/upcoming window; once set, they no longer match. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* A confirmed, non-archived project whose event start is today (MYT) or later and
   that is still missing at least one fleet date its event window could supply. The
   single predicate behind the count, the sample and the UPDATE, so all three agree. */
const SELECT_TARGETS = `
  FROM public.projects
  WHERE status = 'confirmed' AND archived_at IS NULL
    AND start_date IS NOT NULL
    AND substr(start_date, 1, 10)::date >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
    AND (
      (setup_start_at IS NULL)
      OR (dismantle_start_at IS NULL AND end_date IS NOT NULL)
    )`;

const SETUP_EXPR = `to_char(substr(start_date, 1, 10)::date - 1, 'YYYY-MM-DD')`;
const DISMANTLE_EXPR = `to_char(substr(end_date, 1, 10)::date + 1, 'YYYY-MM-DD')`;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}`);

  const [{ n: total, setups, dismantles }] = await sql.unsafe(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE setup_start_at IS NULL)::int AS setups,
           COUNT(*) FILTER (WHERE dismantle_start_at IS NULL AND end_date IS NOT NULL)::int AS dismantles
    ${SELECT_TARGETS}`);
  note(`\n=== CONFIRMED UPCOMING PROJECTS MISSING A FLEET DATE ===`);
  note(`  projects to touch: ${total}   (setup to fill: ${setups}, dismantle to fill: ${dismantles})`);

  if (!total) { note(`\nNothing to backfill.`); await sql.end({ timeout: 5 }); return; }

  // Per-month breakdown by event start — counts only (public logs).
  const byMonth = await sql.unsafe(`
    SELECT to_char(substr(start_date,1,10)::date, 'YYYY-MM') AS mth, COUNT(*)::int AS n
    ${SELECT_TARGETS}
    GROUP BY 1 ORDER BY 1`);
  note(`  by event month:`);
  for (const r of byMonth) note(`    ${r.mth}: ${r.n}`);

  // Capped sample of the actual change — id, code (an internal identifier) and the
  // dates only; no names/venues, since Actions logs are public.
  const sample = await sql.unsafe(`
    SELECT id::text AS id, code,
           substr(start_date,1,10) AS start_date, substr(end_date,1,10) AS end_date,
           setup_start_at, dismantle_start_at,
           CASE WHEN setup_start_at IS NULL THEN ${SETUP_EXPR} END AS new_setup,
           CASE WHEN dismantle_start_at IS NULL AND end_date IS NOT NULL THEN ${DISMANTLE_EXPR} END AS new_dismantle
    ${SELECT_TARGETS}
    ORDER BY substr(start_date,1,10) LIMIT 20`);
  note(`\n=== SAMPLE (first ${sample.length}) ===`);
  for (const r of sample) {
    note(`  ${String(r.code ?? r.id).padEnd(26)} event ${r.start_date}..${r.end_date ?? '-'}  ` +
      `setup ${r.setup_start_at ?? '(none)'}->${r.new_setup ?? r.setup_start_at ?? '-'}  ` +
      `dismantle ${r.dismantle_start_at ?? '(none)'}->${r.new_dismantle ?? r.dismantle_start_at ?? '-'}`);
  }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== BACKFILLING ${total} PROJECT(S) ===`);
  const written = await sql.unsafe(`
    UPDATE public.projects
       SET setup_start_at = CASE WHEN setup_start_at IS NULL THEN ${SETUP_EXPR} ELSE setup_start_at END,
           dismantle_start_at = CASE WHEN dismantle_start_at IS NULL AND end_date IS NOT NULL
                                     THEN ${DISMANTLE_EXPR} ELSE dismantle_start_at END,
           updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
     WHERE id IN (SELECT id ${SELECT_TARGETS})
   RETURNING id::text AS id`);
  note(`  rows written: ${written.length} of ${total}`);

  await sql.end({ timeout: 5 });

  // Verify on a FRESH connection: no confirmed/upcoming project is left without the
  // date its window implies (count), and a few rows now read the derived dates.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const [{ n: left }] = await check.unsafe(`SELECT COUNT(*)::int AS n ${SELECT_TARGETS}`);
    if (left) bad(`  ${left} confirmed/upcoming project(s) still missing a fleet date`);
    else note(`  0 confirmed/upcoming projects left missing a fleet date (was ${total}).`);
    const after = await check.unsafe(`
      SELECT code, setup_start_at, dismantle_start_at
        FROM public.projects
       WHERE status = 'confirmed' AND archived_at IS NULL AND start_date IS NOT NULL
         AND substr(start_date,1,10)::date >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
       ORDER BY substr(start_date,1,10) LIMIT 8`);
    for (const r of after) note(`  ${String(r.code ?? '-').padEnd(26)} setup ${r.setup_start_at ?? '(none)'}  dismantle ${r.dismantle_start_at ?? '(none)'}`);
    if (left) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
