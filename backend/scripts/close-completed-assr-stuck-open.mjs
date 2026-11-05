#!/usr/bin/env node
/* close-completed-assr-stuck-open.mjs — Service Cases that FINISHED but were
   never closed, so they sit on the Delivery Planning board forever.

   WHAT IS WRONG. A Service Case (public.assr_cases) leaves the Delivery
   Planning board only when closed_at (or archived_at) is stamped — never
   because its stage text says 'completed' (see scm/lib/assr-board-scope.ts:
   the open arm is `closed_at IS NULL AND archived_at IS NULL`). A migration-era
   batch reached stage='completed' / status='Closed' with closed_at STILL NULL,
   so the board treats them as open and keeps rendering their old pickup leg as
   a pending row. The current close path does stamp closed_at (755 completed
   cases carry one); these do not. As of 2026-11-05, 15 of them carry a
   board-driving date (all customer-pickup, dated 2026-03-18..2026-06-13) and
   are the stale rows the owner asked to clear.

   WHAT THIS DOES. Stamp closed_at on completed-but-unclosed cases in scope, so
   they drop off the board. closed_at is dated by the case's own newest LEG date
   (customer pickup / own-team inspection / delivery-back) when it has one; a
   completed case with NO leg date — the wider non-board batch — is dated by
   stage_changed_at (when it entered the 'completed' stage), falling back to
   created_at. Every date used is months old, so a now-closed case does NOT
   reappear on the Delivered tab (that tab keys on the leg date being within 90
   days, not on closed_at). Nothing else is touched: stage and status already
   read completed/Closed; only the missing timestamp is filled.

   SCOPE (env SCOPE). 'board' (default) = only cases carrying a board-driving
   date (customer_pickup_at OR do_date OR an own-team inspection visit) — the 15
   that showed on the board, cleared 2026-11-05. 'all' = every completed-but-
   unclosed case in the company (the wider ~160 non-board batch, dated by
   stage_changed_at / created_at). Always scoped to COMPANY (env COMPANY,
   default 1): company_id is the only write boundary under the service role
   (companyScope.ts).

   MODE=plan (default) lists every target and writes nothing. MODE=apply needs
   CONFIRM="CLOSE COMPLETED ASSR", writes one row at a time behind the same
   guard, then verifies on a FRESH connection that each target now reads a
   closed_at and that nothing completed-and-open remains in scope.

   RE-RUN: inert. The target predicate includes closed_at IS NULL; once a row is
   stamped it no longer matches, so a second run selects nothing and writes
   nothing. Safe to run again.

   REVERSAL: for every id in the apply log, `UPDATE assr_cases SET
   closed_at = NULL WHERE id = <id>;`. The ids are printed so the undo is exact
   and touches only the rows this run changed. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const SCOPE = (process.env.SCOPE || 'board').toLowerCase();
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'CLOSE COMPLETED ASSR';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!Number.isInteger(CO) || CO <= 0) { bad(`COMPANY must be a positive integer, got '${process.env.COMPANY}'`); process.exit(2); }
if (!['board', 'all'].includes(SCOPE)) { bad(`SCOPE must be 'board' or 'all', got '${SCOPE}'`); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* The target set, as a WHERE clause. CO is a validated integer and SCOPE is one
   of two literals, so this is safe to interpolate. 'board' adds the same
   driving-date predicate the board's own union carries (own-team inspection
   only), so plan mode counts exactly the rows the board shows. */
const BOARD_DATE = `(customer_pickup_at IS NOT NULL OR do_date IS NOT NULL
                     OR (inspection_visit_at IS NOT NULL AND inspection_by = 'own'))`;
const targetWhere = () =>
  `stage = 'completed' AND closed_at IS NULL AND archived_at IS NULL
     AND company_id = ${CO}${SCOPE === 'board' ? ` AND ${BOARD_DATE}` : ''}`;

/* The newest LEG date on a case (own-team inspection only, to match the board),
   as a bare YYYY-MM-DD, or NULL when the case drove no fleet trip. Lexicographic
   GREATEST over the text date columns works because they are ISO strings. */
const LEG_DATE_SQL =
  `NULLIF(GREATEST(COALESCE(customer_pickup_at, ''), COALESCE(do_date, ''),
                   COALESCE(CASE WHEN inspection_by = 'own' THEN inspection_visit_at END, '')), '')`;
/* The date to stamp as closed_at: the leg date when there is one, else when the
   case entered the 'completed' stage (stage_changed_at), else created_at. A
   board case always has a leg date; the non-board batch is dated by the stage
   change. NULL only if a case somehow has no date at all (then it is skipped). */
const CLOSE_DATE_SQL =
  `COALESCE(${LEG_DATE_SQL}, NULLIF(TRIM(stage_changed_at), ''), NULLIF(TRIM(created_at), ''))`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} scope=${SCOPE}`);

  const rows = await sql.unsafe(
    `SELECT id, assr_no, company_id, status, stage,
            ${LEG_DATE_SQL} AS leg_date,
            ${CLOSE_DATE_SQL} AS close_date,
            customer_pickup_at, do_date, inspection_visit_at, inspection_by
       FROM assr_cases
      WHERE ${targetWhere()}
      ORDER BY company_id, assr_no`);

  note(`\n=== TARGET: completed Service Cases never stamped closed_at (company ${CO}, scope ${SCOPE}) ===`);
  for (const r of rows) {
    const closedAt = r.close_date ? `${String(r.close_date).slice(0, 10)}T00:00:00.000Z` : null;
    const src = r.leg_date ? 'leg' : 'stage_changed_at/created_at';
    note(`  ${r.assr_no}  id=${r.id}  ->  closed_at=${closedAt ?? '(SKIP: no date)'}${closedAt ? ` [${src}]` : ''}`);
  }
  note(`  target rows: ${rows.length}`);

  if (SCOPE === 'board') {
    const [{ n: allN }] = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM assr_cases
        WHERE stage = 'completed' AND closed_at IS NULL AND archived_at IS NULL AND company_id = ${CO}`);
    note(`  (SCOPE=all would target ${allN} completed-but-unclosed case(s) in company ${CO}, including these ${rows.length})`);
  }

  if (!rows.length) { note(`\nNothing to close.`); await sql.end({ timeout: 5 }); return; }
  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== CLOSING ${rows.length} CASE(S) ===`);
  let wrote = 0;
  for (const r of rows) {
    if (!r.close_date) { note(`  SKIP ${r.assr_no} id=${r.id} — no date to stamp the close by`); continue; }
    const closedAt = `${String(r.close_date).slice(0, 10)}T00:00:00.000Z`;
    const back = await sql`UPDATE assr_cases
         SET closed_at = ${closedAt}
       WHERE id = ${r.id} AND stage = 'completed' AND closed_at IS NULL
         AND archived_at IS NULL AND company_id = ${CO}
      RETURNING id`;
    wrote += back.length;
    note(`  ${back.length ? 'OK  ' : 'SKIP'} ${r.assr_no} id=${r.id} closed_at=${closedAt}`);
  }
  note(`  written: ${wrote} of ${rows.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const ids = rows.map((r) => r.id);
    const after = await check`SELECT id, assr_no, closed_at FROM assr_cases WHERE id = ANY(${ids})`;
    let stillNull = 0;
    for (const a of after) {
      const good = a.closed_at !== null && String(a.closed_at).trim().length > 0;
      if (!good) stillNull++;
      note(`  ${a.assr_no} id=${a.id}: closed_at = ${a.closed_at ?? '(still NULL)'}`);
    }
    const [{ n: remaining }] = await check.unsafe(
      `SELECT COUNT(*)::int AS n FROM assr_cases WHERE ${targetWhere()}`);
    note(`\n  still completed-and-open in scope: ${remaining} (expected 0)`);
    note(`  targets still reading closed_at NULL: ${stillNull} (expected 0)`);
    if (remaining !== 0 || stillNull !== 0) {
      bad(`verification FAILED — ${remaining} still open in scope, ${stillNull} target(s) still NULL`);
      process.exitCode = 1;
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
