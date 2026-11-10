#!/usr/bin/env node
/* An event's finance line with no company. Find them, show them, stamp each with
   its own event's company — and refuse any whose event has none.

   THE SHAPE. project_finance_lines.company_id is the line's company scope (mig
   0170): `refuseForeignChild` reads the line's OWN company_id, so a line with
   NULL there is "someone else's" to every caller and answers 404 on edit or
   delete, on the event page as much as anywhere. Mig 0170 backfilled every line
   that existed then and the app stamps every line it writes since; a later
   one-off ("Total sales (synced from lump)", 2026-09-02) wrote lines without it.

   HOW IT WAS FOUND. 2026-11-05, filling August's fairs from the owner's FAIR PNL
   sheet: three sales lines (events #150, #147, #162) refused a PATCH with 404 while
   every other line of the same events took it.

   THE STAMP. The line's company is its event's (projects.company_id), the rule
   mig 0170 and createLedgerLine both use. An event with no company is refused and
   printed, never guessed. Amounts, dates and categories are not touched.

   MODE=plan (default) prints every NULL line and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", stamps the lines in one
   statement, and verifies on a fresh connection that no stampable line is left
   NULL and that every stamped line's company equals its event's.

   RE-RUN: inert. Keyed on company_id IS NULL, which the stamp turns non-NULL. */
import "./lib/public-log-guard.mjs";
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const NULL_LINES = `
  SELECT l.id::text AS id, l.project_id, l.kind, l.category, l.amount::text AS amount, l.description,
         l.archived_at IS NOT NULL AS archived, p.company_id AS project_company, p.code AS project_code
    FROM project_finance_lines l
    LEFT JOIN projects p ON p.id = l.project_id
   WHERE l.company_id IS NULL
   ORDER BY l.project_id, l.id`;

async function main() {
  const rows = await sql.unsafe(NULL_LINES);
  const fix = rows.filter((r) => r.project_company != null);
  const refuse = rows.filter((r) => r.project_company == null);
  note(`=== ${APPLY ? 'APPLY' : 'PLAN'}: finance lines with no company ===`);
  note(`  found: ${rows.length} · stampable: ${fix.length} · refused (event has no company): ${refuse.length}`);
  const byCo = new Map();
  for (const r of fix) byCo.set(r.project_company, (byCo.get(r.project_company) ?? 0) + 1);
  for (const [co, n] of byCo) note(`  company ${co}: ${n} line(s)`);
  for (const r of rows.slice(0, 200)) {
    note(`  ${r.project_company == null ? 'REFUSE' : 'stamp '} line ${r.id} · event #${r.project_id} ${r.project_code ?? '(no code)'} · ${r.kind}/${r.category} amount=${r.amount}${r.archived ? ' (archived)' : ''} · "${String(r.description ?? '').slice(0, 40)}" → company ${r.project_company ?? '—'}`);
  }
  if (rows.length > 200) note(`  … and ${rows.length - 200} more`);
  for (const r of refuse) bad(`  event #${r.project_id} has no company: line ${r.id} left as it is`);

  if (!APPLY) {
    note('\nPlan only. Nothing written. Re-run with MODE=apply and the CONFIRM phrase.');
    await sql.end({ timeout: 5 });
    return;
  }

  const ids = fix.map((r) => r.id);
  let wrote = 0;
  if (ids.length > 0) {
    const back = await sql.unsafe(
      `UPDATE project_finance_lines l
          SET company_id = p.company_id
         FROM projects p
        WHERE l.project_id = p.id
          AND l.id = ANY($1::bigint[])
          AND l.company_id IS NULL
          AND p.company_id IS NOT NULL
       RETURNING l.id::text AS id`, [ids]);
    wrote = back.length;
  }
  note(`  written: ${wrote} of ${fix.length}`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    const [left] = await check.unsafe(
      `SELECT COUNT(*)::int AS n FROM project_finance_lines l JOIN projects p ON p.id = l.project_id
        WHERE l.company_id IS NULL AND p.company_id IS NOT NULL`);
    if (left.n) bad(`  ${left.n} stampable line(s) still have no company`);
    else note('  no stampable line is left without a company');
    /* The shape, not the count: every stamped line now carries its own event's company. */
    if (ids.length > 0) {
      const [mismatch] = await check.unsafe(
        `SELECT COUNT(*)::int AS n FROM project_finance_lines l JOIN projects p ON p.id = l.project_id
          WHERE l.id = ANY($1::bigint[]) AND l.company_id IS DISTINCT FROM p.company_id`, [ids]);
      if (mismatch.n) bad(`  ${mismatch.n} stamped line(s) carry a company other than their event's`);
      else note(`  all ${ids.length} stamped line(s) carry their event's company`);
      if (left.n || mismatch.n) process.exitCode = 1;
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
