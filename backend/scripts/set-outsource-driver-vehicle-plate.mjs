#!/usr/bin/env node
/* Make the lorry-plate match key EXPLICIT on the 3PL "lorry account" driver rows.
 *
 * WHY. Owner 2026-11-28, one phone per lorry: an Outsource Transporter login is
 * named after its PLATE ("MCF 3084") and linked to its own scm.drivers row, and
 * resolveDeliveryScope (src/scm/lib/deliveryScope.ts) now scopes such a login to
 * every delivery on its plate. That scope derives the plate from the driver row's
 * `vehicle` if set, ELSE the account `name`. Today `vehicle` is NULL on all three
 * accounts, so the scope already works off `name` — this script just writes the
 * plate into `vehicle` so the key is a stated field rather than an implicit
 * name-fallback (and so on-time-load / packing-day, which already read `vehicle`
 * as a plate, agree). It is a touch-up, not a prerequisite: the feature ships and
 * works without ever running this.
 *
 * SCOPE, tight. Only scm.drivers rows whose user_id links an "Outsource
 * Transporter" position AND whose `vehicle` IS NULL. Person-driver rows (in-house
 * Drivers) are never touched — their name is not a plate and must stay off the
 * lorry-plate arm. `vehicle` is set to the account `name` (normalizePlate
 * canonicalises both sides at match time, so the spaced name "MCF 3084" matches
 * scm.lorries.plate "MCF3084"); a row with a blank name is skipped.
 *
 * MODE=plan (default) lists the rows it WOULD set and writes nothing.
 * MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", writes, then verifies
 * on a FRESH connection that each touched row's vehicle is now a non-null text
 * value equal to its name, and that no Outsource Transporter row is left NULL.
 *
 * RE-RUN: inert. The WHERE is `vehicle IS NULL`, which a successful apply makes
 * false for every row it set, so a second run finds nothing to do and writes
 * nothing. It never overwrites a vehicle an admin later changed. */
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

// The candidate predicate, shared by the plan read, the write and the verify so
// all three ask about exactly the same rows.
const OUTSOURCE_LINK = `user_id IN (
  SELECT u.id FROM public.users u
  JOIN public.positions p ON p.id = u.position_id
  WHERE p.slug = 'outsource_transporter'
)`;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}`);

  const candidates = await sql.unsafe(
    `SELECT id::text AS id, name, vehicle FROM scm.drivers
      WHERE vehicle IS NULL AND nullif(btrim(name), '') IS NOT NULL AND ${OUTSOURCE_LINK}
      ORDER BY name`);
  note(`\n=== rows that WOULD get vehicle := name (${candidates.length}) ===`);
  for (const r of candidates) note(`  ${r.id}  name="${r.name}"  vehicle=${r.vehicle ?? '(null)'} -> "${r.name}"`);

  // Rows already set (for visibility only) and any blank-name outsource rows we skip.
  const already = await sql.unsafe(
    `SELECT COUNT(*)::int AS n FROM scm.drivers WHERE vehicle IS NOT NULL AND ${OUTSOURCE_LINK}`);
  note(`  (already set: ${already[0].n})`);

  if (!candidates.length) { note('\nNothing to set.'); await sql.end({ timeout: 5 }); return; }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== SETTING vehicle := name ===`);
  const wrote = await sql.unsafe(
    `UPDATE scm.drivers SET vehicle = name
      WHERE vehicle IS NULL AND nullif(btrim(name), '') IS NOT NULL AND ${OUTSOURCE_LINK}
     RETURNING id::text AS id`);
  note(`  rows written: ${wrote.length}`);

  await sql.end({ timeout: 5 });

  // Verify on a FRESH connection — assert the SHAPE (vehicle is now a non-null
  // text value equal to name), not just a row count, and that no Outsource
  // Transporter row is left with a NULL vehicle.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const ids = wrote.map((r) => r.id);
    const rows = ids.length
      ? await check.unsafe(
          `SELECT id::text AS id, name, vehicle, pg_typeof(vehicle)::text AS vtype,
                  (vehicle IS NOT NULL AND vehicle = name) AS ok
             FROM scm.drivers WHERE id = ANY($1::uuid[]) ORDER BY name`, [ids])
      : [];
    let wrong = 0;
    for (const r of rows) {
      note(`  ${r.id}  vehicle="${r.vehicle}" (${r.vtype})  == name? ${r.ok}`);
      if (!r.ok || r.vtype !== 'text') wrong++;
    }
    const [leftNull] = await check.unsafe(
      `SELECT COUNT(*)::int AS n FROM scm.drivers
        WHERE vehicle IS NULL AND nullif(btrim(name), '') IS NOT NULL AND ${OUTSOURCE_LINK}`);
    note(`  Outsource rows still vehicle IS NULL (non-blank name): ${leftNull.n}`);
    if (wrong > 0) bad(`  ${wrong} row(s) did not land as a text value equal to name`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
