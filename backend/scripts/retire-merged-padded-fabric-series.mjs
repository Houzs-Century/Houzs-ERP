#!/usr/bin/env node
// retire-merged-padded-fabric-series — finish a fabric-series merge by switching
// off the EMPTIED duplicate row, so the catalogue stops offering the same fabric
// twice.
//
// WHAT THIS IS THE SECOND HALF OF. `scm.fabric_library` held two ids that differ
// from themselves trimmed while the trimmed twin existed beside them:
// `GARFIELD ` and `TARONI `. Somebody merged GARFIELD on 2026-08-11 and left a
// tombstone in the row's own label:
//
//   "GARFIELD  [MERGED into GARFIELD on 2026-08-11 - superseded, not deleted]"
//
// `repair-fabric-colour-padded-series.mjs` moved the three stranded colours onto
// the clean rows (applied 2026-09-11). What is left is `TARONI `, now holding
// ZERO colours and still ACTIVE - so the fabric list shows TARONI twice and one
// of them can never be picked from. Owner 2026-09-11, asked what to do with the
// duplicates: 「这种有异样的 fabric 全部 merge 起来」.
//
// This writes the same tombstone GARFIELD got and switches the row off.
//
// WHY IT COULD NOT BE DONE EARLIER, and this is the part worth keeping. Switching
// a padded row off was DANGEROUS until 2026-09-11: `GET /fabric-colours` hid a
// colour whose series was retired by comparing TRIMMED ids, so retiring
// `TARONI ` would have hidden the live `TARONI`'s 15 colours - the regression
// that shipped and was fixed per-CODE in PR #3672/#3681. Both are merged and
// deployed (deploy run 34595512433, backend + frontend success), so the
// comparison now asks whether the CODE has any live row. Verified after that
// deploy: HR805 keeps all 7 colours including HR805-90, and no colour sits on a
// padded series with a clean twin.
//
// REFUSES rather than guesses. A padded row is retired ONLY when
//   * a row exists at the trimmed id, and it is ACTIVE - otherwise switching
//     this one off takes the fabric out of the catalogue entirely, and
//   * this row holds NO colours - a row with colours still on it is a merge
//     nobody has finished, and moving them is the other script's job.
// Anything else is printed and skipped.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="RETIRE MERGED SERIES".
// RE-RUN: idempotent. A retired row no longer matches (the filter wants
// active = true), so a second run finds nothing and writes nothing; the
// fresh-connection check asserts that SHAPE - the row is off AND its clean twin
// is still on, which a row count would not have told you.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').trim().toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'RETIRE MERGED SERIES';
const TODAY = new Date().toISOString().slice(0, 10);

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fail = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`); process.exit(1); };

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}" - refusing.`);
  process.exit(2);
}

/** Every ACTIVE padded row, with what decides whether it may be retired. */
const FIND = `
  SELECT l.company_id, l.id AS padded, btrim(l.id) AS clean, l.label,
         t.active AS twin_active,
         (SELECT count(*)::int FROM scm.fabric_colours c
           WHERE c.company_id = l.company_id AND c.fabric_id = l.id) AS colours_left
    FROM scm.fabric_library l
    JOIN scm.fabric_library t
      ON t.company_id = l.company_id AND t.id = btrim(l.id)
   WHERE l.id <> btrim(l.id)
     AND l.active = true
   ORDER BY l.company_id, l.id`;

const tombstone = (clean) => `[MERGED into ${clean} on ${TODAY} - superseded, not deleted]`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (no writes)'}`);
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const rows = await sql.unsafe(FIND);

  const retire = rows.filter((r) => r.twin_active === true && r.colours_left === 0);
  const refused = rows.filter((r) => !(r.twin_active === true && r.colours_left === 0));

  note('');
  note(`Active duplicate series rows (padded id, clean twin present): ${rows.length}`);
  for (const r of retire) {
    note(`   company ${r.company_id}  ${JSON.stringify(r.padded)} -> off, label gains "${tombstone(r.clean)}"`);
  }
  if (refused.length) {
    note('');
    note(`REFUSED - retiring these would hide a fabric, or the merge is unfinished: ${refused.length}`);
    for (const r of refused) {
      const why = r.twin_active !== true
        ? `the clean row ${JSON.stringify(r.clean)} is itself switched OFF`
        : `${r.colours_left} colour(s) still sit on this row - move them first (repair-fabric-colour-padded-series.mjs)`;
      note(`   ${JSON.stringify(r.padded)}: ${why}`);
    }
  }

  if (!APPLY) {
    note('');
    note(`PLAN: ${retire.length} row(s) would be retired. Nothing changed.`);
    note(`Re-run MODE=apply CONFIRM="${CONFIRM_PHRASE}" to apply.`);
    await sql.end();
    return;
  }
  if (retire.length === 0) { note('\nNothing to retire.'); await sql.end(); return; }

  await sql.begin(async (tx) => {
    for (const r of retire) {
      /* The label keeps the ORIGINAL text and gains the note, so the row still
         reads as the fabric it was - the same shape GARFIELD's merge left. */
      const label = `${r.label ?? r.padded} ${tombstone(r.clean)}`;
      await tx`UPDATE scm.fabric_library
                  SET active = false, label = ${label}
                WHERE company_id = ${r.company_id} AND id = ${r.padded}`;
    }
  });
  note('');
  note(`APPLIED: ${retire.length} duplicate series row(s) retired.`);
  await sql.end();

  /* FRESH connection, and the SHAPE both ways: the padded row is OFF and its
     clean twin is still ON. A row count would have been happy with a repair
     that switched off the wrong one of the pair. */
  const v = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const bad = [];
  for (const r of retire) {
    const [after] = await v`SELECT active, label FROM scm.fabric_library
                             WHERE company_id = ${r.company_id} AND id = ${r.padded}`;
    const [twin] = await v`SELECT active FROM scm.fabric_library
                            WHERE company_id = ${r.company_id} AND id = ${r.clean}`;
    const [colours] = await v`SELECT count(*)::int n FROM scm.fabric_colours
                               WHERE company_id = ${r.company_id} AND fabric_id = ${r.clean} AND active = true`;
    if (!after) bad.push(`${JSON.stringify(r.padded)}: row is gone`);
    else if (after.active !== false) bad.push(`${JSON.stringify(r.padded)}: still active`);
    else if (!String(after.label ?? '').includes('MERGED into')) bad.push(`${JSON.stringify(r.padded)}: label carries no merge note`);
    if (!twin || twin.active !== true) bad.push(`${JSON.stringify(r.clean)}: the LIVE row is not active - the wrong row was switched off`);
    if ((colours?.n ?? 0) === 0) bad.push(`${JSON.stringify(r.clean)}: has no active colours left to offer`);
  }
  await v.end();
  if (bad.length) fail(`VERIFY FAILED: ${bad.join('; ')}`);
  note(`VERIFIED on a fresh connection: each retired row is off and carries its merge note, and every clean twin is still active with colours to offer.`);
}

main().catch((e) => fail(e?.message ?? String(e)));
