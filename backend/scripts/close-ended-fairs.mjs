#!/usr/bin/env node
/* close-ended-fairs — mark PAST exhibition projects Completed in one reviewed,
   reversible pass, so the active list stops carrying fairs that already ended.

   WHY. Non-archived projects (company 1) sit in draft/setup/live with an
   end_date already in the past; every reader still treats them as open work.
   The owner asked (2026-10-21) to close the OLD fairs only — the ones that have
   already ended — and to leave untouched the upcoming fairs (end_date today or
   later, through 2027-07) and anything already Cancelled.

   WHAT IT TOUCHES. Exactly the rows matching, together:
     company_id = COMPANY (default 1)
     archived_at IS NULL
     stage  <> 'completed'
     status <> 'cancelled'
     end_date IS NOT NULL AND end_date < CUTOFF   (default 2026-10-21)
   For each, stage -> 'completed', status -> 'confirmed', updated_at bumped, and
   one project_activity 'stage_change' row (prev stage -> completed) so each
   project's own timeline records the close, exactly as the app's PATCH would.
   No finance, no stock, no checklist, no date shift.

   MODE=plan (default) prints every targeted row and the control counts and
   writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE PLAN AND WILL CLOSE THESE FAIRS", writes inside
   one transaction, then re-reads on a FRESH connection and asserts the SHAPE:
   every targeted id now reads stage=completed/status=confirmed, zero rows still
   match the predicate, and the untouched controls (upcoming, cancelled) have
   not moved.

   REVERSAL. The plan output lists each id with its prior stage and status; to
   undo, set those rows back to the printed stage and status.

   RE-RUN: inert. The predicate requires stage <> 'completed', and every row
   this script writes no longer satisfies that, so a second run targets nothing. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const CO = Number(process.env.COMPANY || 1);
const CUTOFF = process.env.CUTOFF || '2026-10-21';
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE PLAN AND WILL CLOSE THESE FAIRS';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* $1 = company, $2 = cutoff. The SAME predicate guards the plan read, the write
   and the re-run check, so what is shown is exactly what is written. */
const PRED =
  `company_id = $1 AND archived_at IS NULL AND stage <> 'completed' ` +
  `AND status <> 'cancelled' AND end_date IS NOT NULL AND end_date < $2`;

/* The rows the owner asked to LEAVE ALONE, counted so the verification can
   prove the write did not reach them. */
async function controls(client) {
  const [r] = await client.unsafe(
    `SELECT
       (SELECT count(*)::int FROM projects WHERE company_id = $1 AND archived_at IS NULL
          AND stage <> 'completed' AND status <> 'cancelled'
          AND (end_date IS NULL OR end_date >= $2))                 AS upcoming,
       (SELECT count(*)::int FROM projects WHERE company_id = $1 AND archived_at IS NULL
          AND status = 'cancelled')                                  AS cancelled,
       (SELECT count(*)::int FROM projects WHERE company_id = $1
          AND stage = 'completed')                                   AS completed`,
    [CO, CUTOFF]);
  return r;
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} cutoff=${CUTOFF}`);

  const targets = await sql.unsafe(
    `SELECT id::int AS id, code, stage, status, end_date
       FROM projects WHERE ${PRED} ORDER BY end_date, id`,
    [CO, CUTOFF]);
  const before = await controls(sql);

  note(`\n=== WILL CLOSE ${targets.length} FAIR(S) (stage -> completed, status -> confirmed) ===`);
  for (const t of targets) {
    note(`  ${String(t.id).padStart(5)}  ${t.end_date}  ${String(t.stage).padEnd(8)} ${String(t.status).padEnd(10)} ${t.code}`);
  }
  note(`\n  leave untouched: ${before.upcoming} upcoming (end_date >= ${CUTOFF} or unset), ${before.cancelled} cancelled`);
  note(`  currently completed (company ${CO}): ${before.completed}`);

  if (!targets.length) { note(`\nNothing to close.`); await sql.end({ timeout: 5 }); return; }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== CLOSING ${targets.length} ROW(S) ===`);
  const closed = await sql.begin(async (tx) => {
    const rows = await tx.unsafe(
      `SELECT id::int AS id, stage FROM projects WHERE ${PRED} ORDER BY id`, [CO, CUTOFF]);
    const updated = await tx.unsafe(
      `UPDATE projects SET stage = 'completed', status = 'confirmed',
              updated_at = to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')
        WHERE ${PRED} RETURNING id::int AS id`, [CO, CUTOFF]);
    for (const r of rows) {
      await tx.unsafe(
        `INSERT INTO project_activity (project_id, action, from_value, to_value, note, user_id, company_id)
         VALUES ($1, 'stage_change', $2, 'completed', $3, NULL, $4)`,
        [r.id, r.stage, `bulk close: fair ended before ${CUTOFF} (old-fair cleanup)`, CO]);
    }
    return { ids: updated.map((x) => x.id), count: rows.length };
  });
  const updatedIds = closed.ids;
  note(`  updated ${updatedIds.length} project(s), wrote ${closed.count} stage_change activity row(s)`);
  if (updatedIds.length !== targets.length) {
    note(`  note: ${targets.length} planned, ${updatedIds.length} written (data changed between plan read and write)`);
  }

  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const [{ n: stillOpen }] = await check.unsafe(
      `SELECT count(*)::int AS n FROM projects WHERE ${PRED}`, [CO, CUTOFF]);
    const rows = await check.unsafe(
      `SELECT stage, status FROM projects WHERE id = ANY($1::int[])`, [updatedIds]);
    const wrongShape = rows.filter((r) => r.stage !== 'completed' || r.status !== 'confirmed');
    const after = await controls(check);

    note(`  targeted rows still open (must be 0): ${stillOpen}`);
    note(`  re-read ${rows.length} written row(s); not completed/confirmed: ${wrongShape.length}`);
    note(`  controls -> upcoming ${before.upcoming}->${after.upcoming}, cancelled ${before.cancelled}->${after.cancelled}, completed ${before.completed}->${after.completed}`);
    note(`  sample written shape: ${JSON.stringify(rows.slice(0, 5))}`);

    const problems = [];
    if (stillOpen !== 0) problems.push(`${stillOpen} targeted row(s) still match the predicate`);
    if (wrongShape.length) problems.push(`${wrongShape.length} written row(s) are not completed/confirmed`);
    if (after.upcoming !== before.upcoming) problems.push(`upcoming changed ${before.upcoming}->${after.upcoming} — scope leaked`);
    if (after.cancelled !== before.cancelled) problems.push(`cancelled changed ${before.cancelled}->${after.cancelled} — scope leaked`);
    if (after.completed !== before.completed + updatedIds.length) {
      problems.push(`completed moved by ${after.completed - before.completed}, expected +${updatedIds.length}`);
    }

    if (problems.length) { for (const p of problems) bad(`  ${p}`); process.exit(1); }
    note(`\n  OK: ${updatedIds.length} old fair(s) closed; upcoming and cancelled untouched.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
