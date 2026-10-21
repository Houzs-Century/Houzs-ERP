#!/usr/bin/env node
/* Bulk-set the OPERATION checklist items on past fairs, at the owner's request
   (2026-10-21). The UI has no bulk control and this spans a few hundred rows.

   These are ordinary checklist items (not pills). Clicking N/A or Done in the UI
   goes through services/projects.ts setChecklistStatus, which (a) sets status and
   completed_by/completed_at, and (b) writes one project_activity row
   (action 'checklist_status', from the old status to the new, note = the item
   title). This script reproduces both, per item, so each change shows in the
   project's activity trail exactly as a click would. Acting user = 1
   (HOUZS CENTURY), the owner's own account.

   WHAT IT SETS. Company 1, active (archived_at IS NULL), OPERATION-section items
   that are still PENDING (items already Done or N/A are left alone), on PAST
   fairs (end_date before today in Asia/Kuala_Lumpur):

     A. Past EXHIBITIONS: every pending OPERATION item -> 'na', EXCEPT a ZANOTTI
        exhibition's Decoration item (handled by B).
     B. Past ZANOTTI exhibitions: the pending Decoration item -> 'done'.
     C. Past SOLO fairs: the pending Decoration item -> 'done'. Solo fairs' other
        OPERATION items are left untouched (the N/A sweep is exhibitions only).

   The three sets are disjoint and each requires status = 'pending', so order does
   not matter and nothing is touched twice.

   MODE=plan (default) lists every item it WOULD change -- id, project code/name,
   brand, item, current status -> target -- and writes nothing. That list is the
   backup: the old state of every touched item is printed into the run log.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE PLAN", runs the three changes
   (each a single statement that updates the items AND inserts their activity
   rows), then re-reads on a FRESH connection and asserts no in-scope item is
   still pending.

   RE-RUN: inert. Every change requires status = 'pending'; once an item is 'na'
   or 'done' it no longer matches, so a second run changes nothing and logs no new
   activity. The fresh-connection check then reports zero pending in scope. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const ACTOR = Number(process.env.ACTOR || 1); // HOUZS CENTURY — the acting user stamped on done/activity
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE PLAN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const TODAY_MYT = `(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`;
const NOW_UTC = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

/* Each change: its target status, whether it stamps completion, and the
   PROJECT/ITEM scope predicate. `ref` is the checklist table reference, so the
   same predicate serves the aliased SELECTs (c) and the un-aliased UPDATE. */
const CHANGES = [
  {
    name: 'A. Exhibitions: pending OPERATION -> N/A (except Zanotti Decoration)',
    target: 'na',
    done: false,
    scope: (ref) => `et.slug = 'exhibition'
            AND p.end_date IS NOT NULL AND p.end_date::date < ${TODAY_MYT}
            AND (p.brand IS DISTINCT FROM 'ZANOTTI' OR ${ref}.title <> 'Decoration')`,
  },
  {
    name: 'B. Zanotti exhibitions: pending Decoration -> Done',
    target: 'done',
    done: true,
    scope: (ref) => `et.slug = 'exhibition'
            AND p.end_date IS NOT NULL AND p.end_date::date < ${TODAY_MYT}
            AND p.brand = 'ZANOTTI' AND ${ref}.title = 'Decoration'`,
  },
  {
    name: 'C. Solo fairs: pending Decoration -> Done',
    target: 'done',
    done: true,
    scope: (ref) => `et.slug = 'solo'
            AND p.end_date IS NOT NULL AND p.end_date::date < ${TODAY_MYT}
            AND ${ref}.title = 'Decoration'`,
  },
];

/* Conditions common to every change, minus the project_id = p.id join (added per
   query) and minus the spec scope. */
const common = (ref, ch) => `${ref}.company_id = $1
      AND ${ref}.status = 'pending'
      AND EXISTS (SELECT 1 FROM project_checklist_sections s
                   WHERE s.id = ${ref}.section_id AND s.name = 'OPERATION')
      AND p.archived_at IS NULL
      AND ${ch.scope(ref)}`;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* The in-scope items still pending -- what a plan run lists and an apply run is
   about to change. */
function listTargets(client, ch) {
  return client.unsafe(
    `SELECT c.id::text AS id, p.code AS code, p.name AS name, p.brand AS brand, c.title AS item
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
      WHERE ${common('c', ch)}
      ORDER BY p.code NULLS LAST, c.title, c.id`,
    [CO],
  );
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} actor=${ACTOR}`);

  const planned = [];
  for (const ch of CHANGES) {
    const rows = await listTargets(sql, ch);
    planned.push({ ch, rows });
    note(`\n=== ${ch.name} ===`);
    note(`  items to change: ${rows.length}`);
    for (const r of rows) {
      note(`  id ${String(r.id).padStart(6)}  ${String(r.code ?? '-').padEnd(32)} ${String(r.brand ?? '-').padEnd(10)} ${String(r.item).padEnd(26)} pending -> ${ch.target}   ${r.name ?? ''}`);
    }
  }
  const totalPlanned = planned.reduce((s, p) => s + p.rows.length, 0);
  note(`\n  TOTAL items to change: ${totalPlanned}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== WRITING ===`);
  let wrote = 0;
  for (const { ch, rows } of planned) {
    const completedBy = ch.done ? String(ACTOR) : 'NULL';
    const completedAt = ch.done ? NOW_UTC : 'NULL';
    /* One statement: update the items, then log one activity row per updated
       item (same columns setChecklistStatus's logger writes; id/created_at/
       company_id take their defaults). */
    const r = await sql.unsafe(
      `WITH upd AS (
         UPDATE project_checklist
            SET status = '${ch.target}',
                completed_by = ${completedBy},
                completed_at = ${completedAt},
                updated_at = ${NOW_UTC}
           FROM projects p
           LEFT JOIN project_event_types et ON et.id = p.event_type_id
          WHERE project_checklist.project_id = p.id
            AND ${common('project_checklist', ch)}
         RETURNING project_checklist.project_id AS project_id, project_checklist.title AS title
       ),
       act AS (
         INSERT INTO project_activity (project_id, action, from_value, to_value, note, user_id)
         SELECT project_id, 'checklist_status', 'pending', '${ch.target}', title, ${ACTOR} FROM upd
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM upd)::int AS updated, (SELECT count(*) FROM act)::int AS logged`,
      [CO],
    );
    const updated = r[0]?.updated ?? 0;
    const logged = r[0]?.logged ?? 0;
    wrote += updated;
    note(`  ${ch.name}: updated ${updated}, logged ${logged} (planned ${rows.length})`);
    if (updated !== rows.length || logged !== updated) {
      bad(`  COUNT MISMATCH on "${ch.name}": updated ${updated}, logged ${logged}, planned ${rows.length}`);
    }
  }
  note(`  items changed: ${wrote} of ${totalPlanned}`);

  await sql.end({ timeout: 5 });

  /* Verify on a FRESH connection: assert nothing in scope is still pending, and
     print the resulting status spread (values, not just a count). */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let remaining = 0;
    for (const ch of CHANGES) {
      const left = await check.unsafe(
        `SELECT c.id::text AS id, c.title AS item, c.status AS status
           FROM project_checklist c
           JOIN projects p ON p.id = c.project_id
           LEFT JOIN project_event_types et ON et.id = p.event_type_id
          WHERE ${common('c', ch)}
          ORDER BY c.id`,
        [CO],
      );
      remaining += left.length;
      note(`  ${ch.name}: ${left.length} still pending in scope`);
      for (const r of left) bad(`      STILL PENDING: id ${r.id} ${r.item}`);
    }
    if (remaining > 0) {
      bad(`  ${remaining} in-scope item(s) still pending after apply`);
      process.exitCode = 1;
    } else {
      note(`  no in-scope item is still pending -- all landed at na/done`);
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
