#!/usr/bin/env node
/* Set the PMS payment / deposit pills in bulk, at the owner's request (2026-10-21).

   Two checklist "pill" rows (mig 090) hold a project's payment state in
   project_checklist.pill_value. The UI sets them through the ordinary checklist
   PATCH (services/projects.ts patchChecklistItem) — a plain UPDATE of pill_value
   and updated_at, with NO activity row and NO payment_updated stamp. This script
   does that same UPDATE across many projects at once, because the UI has no bulk
   control and there are a few hundred rows to touch.

   WHAT IT SETS. Company 1, active (archived_at IS NULL) projects, and ONLY rows
   that already have the pill — a project that never got the pill row is left
   untouched, exactly as a user with no pill to click would leave it:

     1. Rental Payment  -> 'fully_paid'  for every PAST event (end_date before
        today in Asia/Kuala_Lumpur), both Exhibition and Solo. A finished event's
        rental is settled.
     2. Security Deposit -> 'none' (= "N/A")  for every EXHIBITION, past or
        upcoming. Exhibitions carry no security deposit; only solo roadshows do.

   The values are the stored keys behind the pill labels (pms-project-status.ts):
   rental 'fully_paid' == "Fully paid"; deposit 'none' == "N/A".

   MODE=plan (default) lists every row it WOULD change — id, project code/name,
   current value -> target — and writes nothing. That list IS the backup: the old
   value of every touched row is printed into the run log.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE PLAN", runs the two UPDATEs, then
   re-reads on a FRESH connection and asserts no in-scope row is still off its
   target value (and prints the resulting value distribution, not just a count).

   RE-RUN: inert. Each UPDATE is keyed on pill_value being DISTINCT FROM its
   target, so a row already at the target is never matched; a second run writes
   nothing and the fresh-connection check reports zero rows remaining off target. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE PLAN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* "Today" is a Malaysian calendar day: an event whose end_date is before today
   in Asia/Kuala_Lumpur is past, regardless of the server clock's zone. */
const TODAY_MYT = `(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`;

/* Each change names the pill, its target value, and the PROJECT-scope predicate
   that decides which projects are in scope. The pill_value match is added
   separately so one predicate drives the plan list, the UPDATE and the re-read. */
const CHANGES = [
  {
    name: 'Rental Payment -> Fully paid (past events, Exhibition + Solo)',
    pill: 'rental_payment',
    target: 'fully_paid',
    scope: `p.archived_at IS NULL
            AND p.end_date IS NOT NULL
            AND p.end_date::date < ${TODAY_MYT}`,
  },
  {
    name: 'Security Deposit -> N/A (all Exhibitions)',
    pill: 'security_deposit',
    target: 'none',
    scope: `p.archived_at IS NULL
            AND et.slug = 'exhibition'`,
  },
];

const FROM = `FROM project_checklist c
              JOIN projects p ON p.id = c.project_id
              LEFT JOIN project_event_types et ON et.id = p.event_type_id`;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* The in-scope rows that are NOT yet at the target — what a plan run lists and an
   apply run is about to write. */
function listTargets(client, ch) {
  return client.unsafe(
    `SELECT c.id::text AS id, p.code AS code, p.name AS name, c.pill_value AS current
       ${FROM}
      WHERE c.company_id = $1
        AND c.pill_kind = '${ch.pill}'
        AND c.pill_value IS DISTINCT FROM '${ch.target}'
        AND ${ch.scope}
      ORDER BY p.code NULLS LAST, c.id`,
    [CO],
  );
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  const planned = [];
  for (const ch of CHANGES) {
    const rows = await listTargets(sql, ch);
    planned.push({ ch, rows });
    note(`\n=== ${ch.name} ===`);
    note(`  rows to change: ${rows.length}`);
    for (const r of rows) {
      note(`  id ${String(r.id).padStart(6)}  ${String(r.code ?? '-').padEnd(34)} ${String(r.current ?? '(unset)').padEnd(10)} -> ${ch.target}   ${r.name ?? ''}`);
    }
  }
  const totalPlanned = planned.reduce((s, p) => s + p.rows.length, 0);
  note(`\n  TOTAL rows to change: ${totalPlanned}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== WRITING ===`);
  let wrote = 0;
  for (const { ch, rows } of planned) {
    /* No alias on the target table, full name in the predicate: the simplest
       shape and the one the write audit recognises. updated_at matches the app's
       own format (UTC, 'YYYY-MM-DD HH24:MI:SS') so the row looks hand-edited. */
    const changed = await sql.unsafe(
      `UPDATE project_checklist
          SET pill_value = '${ch.target}',
              updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
         FROM projects p
         LEFT JOIN project_event_types et ON et.id = p.event_type_id
        WHERE project_checklist.project_id = p.id
          AND project_checklist.company_id = $1
          AND project_checklist.pill_kind = '${ch.pill}'
          AND project_checklist.pill_value IS DISTINCT FROM '${ch.target}'
          AND ${ch.scope}
       RETURNING project_checklist.id::text AS id`,
      [CO],
    );
    wrote += changed.length;
    note(`  ${ch.name}: wrote ${changed.length} (planned ${rows.length})`);
    if (changed.length !== rows.length) {
      bad(`  COUNT MISMATCH on "${ch.name}": wrote ${changed.length}, planned ${rows.length}`);
    }
  }
  note(`  written: ${wrote} of ${totalPlanned}`);

  await sql.end({ timeout: 5 });

  /* Verify on a FRESH connection: ask what value each in-scope row now holds,
     not merely how many rows were touched. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let remaining = 0;
    for (const ch of CHANGES) {
      const left = await check.unsafe(
        `SELECT c.id::text AS id, c.pill_value AS current
           ${FROM}
          WHERE c.company_id = $1
            AND c.pill_kind = '${ch.pill}'
            AND c.pill_value IS DISTINCT FROM '${ch.target}'
            AND ${ch.scope}
          ORDER BY c.id`,
        [CO],
      );
      const dist = await check.unsafe(
        `SELECT c.pill_kind AS pill, c.pill_value AS value, count(*)::int AS n
           ${FROM}
          WHERE c.company_id = $1 AND c.pill_kind = '${ch.pill}' AND ${ch.scope}
          GROUP BY c.pill_kind, c.pill_value
          ORDER BY c.pill_value`,
        [CO],
      );
      remaining += left.length;
      note(`  ${ch.name}: ${left.length} still off-target. In-scope distribution now:`);
      for (const d of dist) note(`      ${d.value ?? '(unset)'}: ${d.n}`);
      for (const r of left) bad(`      STILL OFF: id ${r.id} = ${r.current ?? '(unset)'}`);
    }
    if (remaining > 0) {
      bad(`  ${remaining} in-scope row(s) still off target after apply`);
      process.exitCode = 1;
    } else {
      note(`  all in-scope rows now hold their target value`);
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
