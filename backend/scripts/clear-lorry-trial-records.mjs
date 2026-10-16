#!/usr/bin/env node
/* Clear one lorry's trial records before go-live (owner, 2026-10-16: "帮我把
   vnb9058 除了 work order 的数据 clear 掉").

   Removes, for the lorry PLATE given (default VNB9058):
     - its breakdown cases (scm.lorry_breakdown_cases),
     - its tracked components (scm.lorry_components; their events cascade),
     - the road tax / insurance / PUSPAKOM expiry typed on the lorry master
       (scm.lorries.*_expiry) and any compliance vault rows,
     - preventive-maintenance plans and mileage readings.
   KEEPS: work orders, the lorry itself, its model and registration date.
   A work order pointing at a removed breakdown / component is kept; its link is
   set null by the foreign key (ON DELETE SET NULL).

   MODE=plan (default) prints what would go and writes nothing.
   MODE=apply needs CONFIRM="CLEAR <PLATE> TRIAL RECORDS", runs in one
   transaction, then re-reads on a FRESH connection and fails unless every one of
   those is gone and the work orders are all still there.

   RE-RUN: inert. A second run finds nothing to remove and keeps the work orders. */
import postgres from 'postgres';

const PLATE = (process.env.PLATE || 'VNB9058').trim().toUpperCase();
const MODE = (process.env.MODE || 'plan').toLowerCase();
const PHRASE = `CLEAR ${PLATE} TRIAL RECORDS`;
const APPLY = MODE === 'apply';
if (APPLY && process.env.CONFIRM !== PHRASE) {
  console.error(`apply needs CONFIRM="${PHRASE}"`);
  process.exit(1);
}
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL is not set'); process.exit(2); }
const connect = () => postgres(DSN, { ssl: DSN.includes('sslmode=disable') ? false : 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function snapshot(sql, lorryId) {
  const [r] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM scm.lorry_breakdown_cases WHERE lorry_id = ${lorryId}) AS breakdowns,
      (SELECT COUNT(*)::int FROM scm.lorry_components WHERE lorry_id = ${lorryId}) AS components,
      (SELECT COUNT(*)::int FROM scm.lorry_compliance_documents WHERE lorry_id = ${lorryId}) AS compliance_docs,
      (SELECT COUNT(*)::int FROM scm.lorry_maintenance_plans WHERE lorry_id = ${lorryId}) AS plans,
      (SELECT COUNT(*)::int FROM scm.lorry_mileage_readings WHERE lorry_id = ${lorryId}) AS mileage,
      (SELECT COUNT(*)::int FROM scm.lorry_work_orders WHERE lorry_id = ${lorryId}) AS work_orders,
      (SELECT road_tax_expiry::text FROM scm.lorries WHERE id = ${lorryId}) AS road_tax_expiry,
      (SELECT insurance_expiry::text FROM scm.lorries WHERE id = ${lorryId}) AS insurance_expiry,
      (SELECT puspakom_expiry::text FROM scm.lorries WHERE id = ${lorryId}) AS puspakom_expiry`;
  return r;
}

async function main() {
  const sql = connect();
  try {
    const lorries = await sql`SELECT id, plate, is_internal FROM scm.lorries WHERE upper(replace(plate, ' ', '')) = ${PLATE.replace(/\s+/g, '')}`;
    if (lorries.length !== 1) throw new Error(`expected exactly one lorry ${PLATE}, found ${lorries.length}`);
    const lorry = lorries[0];
    const before = await snapshot(sql, lorry.id);
    const cases = await sql`SELECT case_no, fault_type, status FROM scm.lorry_breakdown_cases WHERE lorry_id = ${lorry.id} ORDER BY case_no`;
    const comps = await sql`SELECT component_type, serial, position FROM scm.lorry_components WHERE lorry_id = ${lorry.id}`;
    note(`lorry ${lorry.plate} (${lorry.id})`);
    note(`before: ${JSON.stringify(before)}`);
    for (const c of cases) note(`  breakdown ${c.case_no} ${c.fault_type ?? ''} ${c.status}`);
    for (const c of comps) note(`  component ${c.component_type} ${c.serial ?? ''} ${c.position ?? ''}`);

    if (!APPLY) { note('PLAN: nothing written. Re-run with MODE=apply and the CONFIRM phrase.'); return; }

    await sql.begin(async (tx) => {
      await tx`DELETE FROM scm.lorry_breakdown_cases WHERE lorry_id = ${lorry.id}`;
      await tx`DELETE FROM scm.lorry_components WHERE lorry_id = ${lorry.id}`;
      await tx`DELETE FROM scm.lorry_compliance_documents WHERE lorry_id = ${lorry.id}`;
      await tx`DELETE FROM scm.lorry_maintenance_plans WHERE lorry_id = ${lorry.id}`;
      await tx`DELETE FROM scm.lorry_mileage_readings WHERE lorry_id = ${lorry.id}`;
      await tx`UPDATE scm.lorries SET road_tax_expiry = NULL, insurance_expiry = NULL, puspakom_expiry = NULL, updated_at = now() WHERE id = ${lorry.id}`;
    });

    // Fresh connection: the read must not ride the writer's session.
    const verify = connect();
    try {
      const after = await snapshot(verify, lorry.id);
      note(`after: ${JSON.stringify(after)}`);
      const cleared = after.breakdowns === 0 && after.components === 0 && after.compliance_docs === 0
        && after.plans === 0 && after.mileage === 0
        && after.road_tax_expiry === null && after.insurance_expiry === null && after.puspakom_expiry === null;
      if (!cleared) throw new Error('verify failed: a trial record is still there');
      if (after.work_orders !== before.work_orders) throw new Error(`verify failed: work orders ${before.work_orders} -> ${after.work_orders}`);
      note(`APPLY OK: cleared; ${after.work_orders} work order(s) kept.`);
    } finally { await verify.end({ timeout: 5 }); }
  } finally { await sql.end({ timeout: 5 }); }
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
