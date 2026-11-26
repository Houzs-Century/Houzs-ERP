#!/usr/bin/env node
/* Put the delivery crew onto ONE delivery order the Last Mile board cannot reach.

   WHY. HC-DO-2610-331 (SO HC-SO-002170, customer M RAVI A/L S MUTUSAMY, Rawang,
   a RM 9,639 delivery on 2026-10-23) was run by MOHD ZAIMIR's VNB9058 that day,
   but it carries NO crew record (scm.delivery_order_crew is empty for it), so
   Trip Pay credits nobody for it. It also never surfaces on the fleet-day Crew
   modal — its SO is an old (2024) order, and the board buckets a DO by its SO's
   delivery date, so this 2026-10-23 DO is not drawn on the 2026-10-23 board and
   the normal "assign crew" screen can't open it. The crew is therefore written
   here, as the dispatcher recorded it (owner, 2026-11-26: "挂到 VNB 那趟").

   WHAT IT WRITES. Exactly one row into scm.delivery_order_crew for this DO:
   driver = MOHD ZAIMIR BIN MOHD SHARANI (VNB9058), helpers = SOWKAT ALI and
   MD NAYIEM HOSSAIN. The _id foreign keys AND the text snapshot columns
   (name / ic / contact / plate) are both filled from the master tables by id,
   the same shape the fleet-day Crew modal writes, so Trip Pay resolves the
   driver by id and the board/run-sheet show the names.

   WHY THE CREW ROW IS ENOUGH (verified against hr-trip-store.ts /
   own-lorry-do-run.ts on 2026-11-26): deliveryOrderRows counts a DO when its
   status counts as delivered (LOADED does — do-shipped-states.ts), it has a run
   date (so_due_date 2026-10-23, in the 23rd–22nd trip month), it is not
   drop-shipped, not 3PL-billed, its crew names an INTERNAL lorry, and it sits on
   no live trip stop. This DO meets all of them once the crew row names VNB9058;
   the script asserts each precondition before it writes.

   REFUSES, never guesses: the DO missing, not HC-SO-002170, not company 1,
   CANCELLED, drop-shipped, 3PL-billed, or already carrying any crew row; or any
   of the four master records (driver / two helpers / lorry) missing or not
   company 1, or the lorry not internal. Each is printed and the run stops.

   MODE=plan (default) resolves and prints the full intended row, writing
   nothing. MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", inserts the
   one row, then re-reads on a FRESH connection and asserts the stored driver /
   helper / lorry VALUES are the ones intended (a row count is not a shape).

   RE-RUN: inert. ON CONFLICT (do_id) DO NOTHING, and the plan refuses outright
   once any crew row exists for the DO, so a second run writes nothing. */

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

// The one delivery order, and the crew the dispatcher recorded for it.
const COMPANY = 1;
const DO_ID = '102b9b41-6c97-4203-8512-187e9337263d';
const EXPECT_SO = 'HC-SO-002170';
const DRIVER_ID = '63a70b65-3063-4220-8a2a-dd5378d45c73';   // MOHD ZAIMIR BIN MOHD SHARANI
const HELPER_1_ID = 'b1a1a4a4-f68b-40a8-9de9-18c5b03edcf6'; // SOWKAT ALI
const HELPER_2_ID = '6ba5377b-61f5-44c9-a6aa-c6d54f24ab8e'; // MD NAYIEM HOSSAIN
const LORRY_ID = 'f93d9a18-eea7-4fdb-9df4-916c9bdbd757';    // VNB9058
// Same actor the fleet-day Crew endpoint stamps on delivery_order_crew.assigned_by.
const ASSIGNED_BY = '00000000-0000-4000-8000-000000000001';

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const stop = async (m) => { bad(m); await sql.end({ timeout: 5 }); process.exit(1); };

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}  company=${COMPANY}  do=${DO_ID}`);

  // 1. The delivery order, with every precondition deliveryOrderRows will test.
  const [d] = await sql`
    SELECT d.id::text, d.so_doc_no, d.company_id, d.status::text AS status,
           d.is_dropship,
           (SELECT count(*)::int FROM scm.threepl_do_charges x WHERE x.do_id = d.id) AS threepl,
           (SELECT count(*)::int FROM scm.delivery_order_crew c WHERE c.do_id = d.id) AS crew_rows
      FROM scm.delivery_orders d WHERE d.id = ${DO_ID}`;
  if (!d) return stop(`delivery order ${DO_ID} not found`);
  if (d.so_doc_no !== EXPECT_SO) return stop(`DO's SO is ${d.so_doc_no}, expected ${EXPECT_SO} — wrong order`);
  if (Number(d.company_id) !== COMPANY) return stop(`DO is company ${d.company_id}, not ${COMPANY}`);
  if (['DRAFT', 'CANCELLED'].includes(String(d.status).toUpperCase())) return stop(`DO status ${d.status} does not count as delivered`);
  if (d.is_dropship === true) return stop(`DO is drop-shipped — Trip Pay would not count it`);
  if (Number(d.threepl) > 0) return stop(`DO is billed by a 3PL — Trip Pay would not count it`);
  if (Number(d.crew_rows) > 0) {
    note(`\nDO already carries ${d.crew_rows} crew row(s) — nothing to do (RE-RUN inert). Leaving it untouched.`);
    await sql.end({ timeout: 5 });
    return;
  }
  note(`\nDO ${EXPECT_SO} / ${DO_ID}: status=${d.status}, dropship=${d.is_dropship}, 3pl=${d.threepl}, crew_rows=0  OK`);

  // 2. Resolve the crew + lorry from the master tables by id (snapshot columns
  //    come from here, so they match the masters exactly).
  const [drv] = await sql`SELECT id::text, name, phone, ic_number, company_id FROM scm.drivers WHERE id = ${DRIVER_ID}`;
  if (!drv || Number(drv.company_id) !== COMPANY) return stop(`driver ${DRIVER_ID} missing or not company ${COMPANY}`);
  const helpers = await sql`SELECT id::text, name, contact, company_id FROM scm.helpers WHERE id = ANY(${[HELPER_1_ID, HELPER_2_ID]})`;
  const hById = new Map(helpers.map((h) => [h.id, h]));
  const h1 = hById.get(HELPER_1_ID); const h2 = hById.get(HELPER_2_ID);
  if (!h1 || Number(h1.company_id) !== COMPANY) return stop(`helper ${HELPER_1_ID} missing or not company ${COMPANY}`);
  if (!h2 || Number(h2.company_id) !== COMPANY) return stop(`helper ${HELPER_2_ID} missing or not company ${COMPANY}`);
  const [lry] = await sql`SELECT id::text, plate, is_internal, company_id FROM scm.lorries WHERE id = ${LORRY_ID}`;
  if (!lry || Number(lry.company_id) !== COMPANY) return stop(`lorry ${LORRY_ID} missing or not company ${COMPANY}`);
  if (lry.is_internal !== true) return stop(`lorry ${lry.plate} is not internal — Trip Pay would not count the run`);

  const row = {
    do_id: DO_ID, company_id: COMPANY,
    driver_1_id: drv.id, driver_1_name: drv.name, driver_1_ic: drv.ic_number, driver_1_contact: drv.phone,
    helper_1_id: h1.id, helper_1_name: h1.name, helper_1_contact: h1.contact,
    helper_2_id: h2.id, helper_2_name: h2.name, helper_2_contact: h2.contact,
    lorry_id: lry.id, lorry_plate: lry.plate, assigned_by: ASSIGNED_BY,
  };

  note(`\n=== INTENDED crew row (one) ===`);
  note(`  driver_1: ${row.driver_1_name}  ic=${row.driver_1_ic ?? ''}  contact=${row.driver_1_contact ?? ''}`);
  note(`  helper_1: ${row.helper_1_name}  contact=${row.helper_1_contact ?? ''}`);
  note(`  helper_2: ${row.helper_2_name}  contact=${row.helper_2_contact ?? ''}`);
  note(`  lorry:    ${row.lorry_plate} (internal)`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== WRITING 1 crew row ===`);
  const back = await sql`
    INSERT INTO scm.delivery_order_crew
      (do_id, company_id, driver_1_id, driver_1_name, driver_1_ic, driver_1_contact,
       helper_1_id, helper_1_name, helper_1_contact,
       helper_2_id, helper_2_name, helper_2_contact,
       lorry_id, lorry_plate, assigned_by, assigned_at, updated_at)
    VALUES
      (${row.do_id}, ${row.company_id}, ${row.driver_1_id}, ${row.driver_1_name}, ${row.driver_1_ic}, ${row.driver_1_contact},
       ${row.helper_1_id}, ${row.helper_1_name}, ${row.helper_1_contact},
       ${row.helper_2_id}, ${row.helper_2_name}, ${row.helper_2_contact},
       ${row.lorry_id}, ${row.lorry_plate}, ${row.assigned_by}, now(), now())
    ON CONFLICT (do_id) DO NOTHING
    RETURNING do_id`;
  note(`  rows inserted: ${back.length} (0 means a crew row already existed — left as-is)`);

  await sql.end({ timeout: 5 });

  // Verify on a FRESH connection: re-read the stored row and assert the VALUES.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const stored = await check`
      SELECT c.do_id::text, c.driver_1_id::text, c.driver_1_name, c.helper_1_id::text, c.helper_1_name,
             c.helper_2_id::text, c.helper_2_name, c.lorry_id::text, c.lorry_plate, c.company_id,
             l.is_internal AS lorry_internal
        FROM scm.delivery_order_crew c
        LEFT JOIN scm.lorries l ON l.id = c.lorry_id
       WHERE c.do_id = ${DO_ID}`;
    if (stored.length !== 1) return stop(`expected exactly 1 crew row for the DO, found ${stored.length}`);
    const g = stored[0];
    const okDriver = g.driver_1_id === DRIVER_ID;
    const okHelpers = g.helper_1_id === HELPER_1_ID && g.helper_2_id === HELPER_2_ID;
    const okLorry = g.lorry_id === LORRY_ID && g.lorry_internal === true;
    const okCo = Number(g.company_id) === COMPANY;
    note(`  stored: driver="${g.driver_1_name}" helper1="${g.helper_1_name}" helper2="${g.helper_2_name}" lorry=${g.lorry_plate} co=${g.company_id}`);
    if (okDriver && okHelpers && okLorry && okCo) {
      note(`  VERIFIED: driver/helpers/lorry ids match, lorry is internal, company ${COMPANY}. Trip Pay will credit this delivery on the next "Read Delivery Planning".`);
    } else {
      bad(`  MISMATCH: driver=${okDriver} helpers=${okHelpers} lorry=${okLorry} company=${okCo}`);
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
