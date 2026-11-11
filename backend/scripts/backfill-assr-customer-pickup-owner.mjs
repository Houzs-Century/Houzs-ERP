#!/usr/bin/env node
/* Service Cases already on the customer-pickup leg but with no pickup owner —
   default them to our own team so they surface on Delivery Planning.

   WHY. The board (and the HC Delivery sheet) show a Service Case's pickup leg
   only when its own-team marker `pickup_by = 'customer'` is set (service-case.md).
   PR #5647 made entering / switching to the "Pending Customer Pickup" sub-status
   default pickup_by to 'customer' when nobody has chosen who collects — but that
   only fires on a NEW save. Cases that were already sitting on that leg with
   pickup_by null stay invisible until someone re-saves them. This backfills them
   once, applying exactly the same rule the code now applies
   (scm/lib/assr-pickup-default.ts customerPickupOwnTeamDefault).

   SCOPE, and its limit. ONLY rows that the live rule would itself default:
     sub_status = 'pending_customer_pickup'
     AND pickup_by IS NULL or blank         -- nobody has said who collects
     AND the case is open (no closed_at / archived_at).
   An explicit supplier / 3PL leg (pickup_by = 'supplier') is never touched — the
   same row the code refuses to override. No company filter: Service Cases are
   cross-company on this surface by owner ruling (2026-10-01), and the predicate
   targets each row by its own leg state, not a parent key.

   assr_cases lives in the PUBLIC schema, not scm (service-case.md).

   MODE=plan (default) lists every matching case and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes one row at a
   time (re-checking the null guard in the UPDATE so a concurrent save is never
   clobbered), and verifies on a fresh connection that each wrote 'customer' and
   that none of the targeted shape is left behind.

   RE-RUN: inert. Keyed on pickup_by IS NULL/blank, which the write fills, so a
   second run matches nothing. */
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

/* The one predicate — the SQL twin of customerPickupOwnTeamDefault: on the
   customer-pickup leg, open, and no pickup owner chosen yet. Read and write ask
   the DB with the same WHERE so the plan count and the apply guard cannot drift. */
const WHERE = `sub_status = 'pending_customer_pickup'
           AND (pickup_by IS NULL OR btrim(pickup_by) = '')
           AND closed_at IS NULL AND archived_at IS NULL`;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}`);

  const rows = await sql.unsafe(
    `SELECT id::text AS id, assr_no, stage, sub_status, pickup_by, customer_pickup_at
       FROM assr_cases
      WHERE ${WHERE}
      ORDER BY assr_no`);
  note(`\n=== CUSTOMER-PICKUP LEG WITH NO OWNER (will become own team) ===`);
  for (const r of rows) {
    note(`  ${String(r.assr_no).padEnd(16)} id=${r.id} stage=${r.stage} pickup_by=${r.pickup_by ?? '(null)'} pickup_date=${r.customer_pickup_at ?? '-'}`);
  }
  note(`  total: ${rows.length}`);
  if (!rows.length) { note(`\nNothing to backfill.`); await sql.end({ timeout: 5 }); return; }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== SETTING pickup_by = 'customer' ON ${rows.length} CASE(S) ===`);
  let wrote = 0;
  for (const r of rows) {
    /* The null guard is repeated in the UPDATE: a staff save that chose a pickup
       owner between the read and here must win, never be overwritten. */
    const back = await sql.unsafe(
      `UPDATE assr_cases SET pickup_by = 'customer', updated_at = now()
        WHERE id = $1 AND (pickup_by IS NULL OR btrim(pickup_by) = '')
          AND sub_status = 'pending_customer_pickup'
          AND closed_at IS NULL AND archived_at IS NULL
       RETURNING id::text AS id`, [r.id]);
    wrote += back.length;
    note(`  ${back.length ? 'OK  ' : 'SKIP'} ${r.assr_no} (id=${r.id})`);
  }
  note(`  written: ${wrote} of ${rows.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const [{ n }] = await check.unsafe(`SELECT COUNT(*)::int AS n FROM assr_cases WHERE ${WHERE}`);
    if (n > 0) bad(`  ${n} case(s) still on the customer-pickup leg with no owner`);
    note(`  remaining with no owner: ${n} (was ${rows.length})`);
    for (const r of rows) {
      const [row] = await check.unsafe(
        `SELECT pickup_by FROM assr_cases WHERE id = $1`, [r.id]);
      note(`  ${r.assr_no}: pickup_by is now "${row?.pickup_by ?? '(null)'}"`);
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
