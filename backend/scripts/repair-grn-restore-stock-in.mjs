#!/usr/bin/env node
/* Put back the stock IN a re-posted GRN skipped.

   HOW IT HAPPENS. A POSTED GRN is cancelled (one reversing OUT per line), its
   status is set back by hand in the database, and it is posted again. The post
   path's "already booked" guard counts IN rows only, finds the first post's
   INs, and writes no stock. The GRN reads POSTED, the PO reads received, and
   the warehouse is short by exactly the reversal. HC-GRN-2610-045 (2026-10-07)
   is the case this was written for. The app never offers that path; only a
   hand edit reaches it, so the fix is this repair, not a code change.

   WHAT IT WRITES. For each line short by exactly its cancel reversal, one IN
   copied from that line's ORIGINAL IN (warehouse, variant bucket, landed cost,
   batch, movement date), so nothing is re-derived. Plus one RESTORE row on the
   GRN's audit trail. Anything not exactly that shape is refused and printed
   (lib/grn-restore-stock-in.mjs). The GRN row, the PO and the cancel OUTs are
   left alone: they are already right, or honest history.

   GRN_NO and COMPANY_ID are required. MODE=plan (default) prints and writes
   nothing. MODE=apply needs CONFIRM="RESTORE GRN STOCK", writes in one
   transaction, and re-reads on a fresh connection: net IN minus OUT per line
   equals qty accepted, and the open FIFO lots for the GRN cover it.

   RE-RUN: inert. Keyed on net IN minus OUT below qty accepted; after the repair
   they are equal and the plan finds nothing to do. */
import postgres from 'postgres';
import { planGrnStockRestore } from './lib/grn-restore-stock-in.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const GRN_NO = (process.env.GRN_NO ?? '').trim();
const CO = Number(process.env.COMPANY_ID);
if (!GRN_NO || !Number.isInteger(CO) || CO <= 0) { console.error('need GRN_NO and COMPANY_ID'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'RESTORE GRN STOCK';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function readState(client) {
  const grns = await client.unsafe(
    `SELECT id::text AS id, grn_number, status, migrated_no_stock
       FROM scm.grns WHERE grn_number = $1 AND company_id = $2`, [GRN_NO, CO]);
  if (grns.length !== 1) return { grn: null, found: grns.length };
  const grn = grns[0];
  const lines = await client.unsafe(
    `SELECT item_code, qty_accepted::int AS qty_accepted, item_group, unit_price_sen::bigint AS unit_price_sen
       FROM scm.grn_items WHERE grn_id = $1`, [grn.id]);
  const movements = await client.unsafe(
    `SELECT id::text AS id, movement_type::text AS movement_type, item_code, variant_key,
            warehouse_id::text AS warehouse_id, qty::int AS qty, unit_cost_sen::bigint AS unit_cost_sen,
            notes, created_at::text AS created_at
       FROM scm.inventory_movements
      WHERE source_doc_type = 'GRN' AND source_doc_id = $1 AND company_id = $2
      ORDER BY created_at`, [grn.id, CO]);
  return { grn, lines, movements };
}

async function main() {
  const { grn, lines, movements, found } = await readState(sql);
  if (!grn) { bad(`${GRN_NO} in company ${CO}: found ${found} rows, expected 1`); process.exit(1); }

  note(`=== ${GRN_NO} (${grn.status}) ===`);
  for (const l of lines) note(`  line ${l.item_code.padEnd(20)} accepted ${l.qty_accepted}  unit price ${l.unit_price_sen} sen`);
  for (const m of movements) {
    note(`  ${m.created_at.slice(0, 19)}  ${m.movement_type.padEnd(3)} ${m.item_code.padEnd(20)} qty ${m.qty}  cost ${m.unit_cost_sen ?? '-'}  ${m.notes ?? ''}`);
  }

  const plan = planGrnStockRestore(grn, lines, movements);
  if (plan.refuse) { bad(`REFUSED: ${plan.refuse}`); await sql.end({ timeout: 5 }); process.exit(1); }
  for (const r of plan.refused) bad(`  REFUSED ${r.code}: ${r.why}`);
  for (const r of plan.restore) {
    note(`  RESTORE ${r.code.padEnd(20)} +${r.qty} at ${r.unitCostSen} sen (net now ${r.net}, accepted ${r.want}), copying IN ${r.templateId}`);
  }

  /* Anything shipped from these SKUs after the reversal may have run short and
     would normally be re-costed by the post's reconciles. Show it, so a human
     decides before apply. */
  const after = movements.filter((m) => m.movement_type === 'OUT').map((m) => m.created_at).sort().pop();
  if (after && plan.restore.length) {
    const later = await sql.unsafe(
      `SELECT movement_type::text AS t, item_code, qty::int AS qty, source_doc_no, created_at::text AS at
         FROM scm.inventory_movements
        WHERE company_id = $1 AND item_code = ANY($2::text[]) AND created_at > $3::timestamptz
          AND NOT (source_doc_type = 'GRN' AND source_doc_id = $4)
        ORDER BY created_at`, [CO, plan.restore.map((r) => r.code), after, grn.id]);
    for (const l of later) note(`  since the reversal: ${l.at.slice(0, 19)} ${l.t} ${l.item_code} qty ${l.qty} ${l.source_doc_no ?? ''}`);
    if (!later.length) note('  since the reversal: no other movement on these items');
  }

  if (!plan.restore.length) {
    note('Nothing to restore.');
    await sql.end({ timeout: 5 });
    return;
  }
  if (!APPLY) {
    note(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  const restoreNote = 'Restoring receipt: re-post after a hand-reverted cancel skipped the stock IN';
  await sql.begin(async (tx) => {
    for (const r of plan.restore) {
      const back = await tx.unsafe(
        `INSERT INTO scm.inventory_movements
           (movement_type, warehouse_id, item_code, variant_key, product_name, qty, unit_cost_sen,
            source_doc_type, source_doc_id, source_doc_no, movement_date, batch_no, performed_by, company_id, notes)
         SELECT movement_type, warehouse_id, item_code, variant_key, product_name, $2::int, unit_cost_sen,
                source_doc_type, source_doc_id, source_doc_no, movement_date, batch_no, performed_by, company_id, $3
           FROM scm.inventory_movements
          WHERE id = $1 AND company_id = $4 AND movement_type = 'IN'
         RETURNING id::text AS id`, [r.templateId, r.qty, restoreNote, CO]);
      if (back.length !== 1) throw new Error(`insert for ${r.code} wrote ${back.length} rows`);
      note(`  OK ${r.code} +${r.qty} -> movement ${back[0].id}`);
    }
    await tx.unsafe(
      `INSERT INTO scm.entity_audit_log
         (entity_type, entity_id, entity_doc_no, company_id, action, status_snapshot, source, note)
       VALUES ('GRN', $1, $2, $3, 'RESTORE', 'POSTED', 'repair-grn-restore-stock-in', $4)`,
      [grn.id, GRN_NO, CO, `${restoreNote}: ${plan.restore.map((r) => `${r.code} +${r.qty}`).join(', ')}`]);
  });

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    const fresh = await readState(check);
    const again = planGrnStockRestore(fresh.grn, fresh.lines, fresh.movements);
    let ok = !again.refuse && again.restore.length === 0;
    for (const r of plan.restore) {
      const mine = fresh.movements.filter((m) => m.item_code === r.code);
      const net = mine.reduce((s, m) => s + (m.movement_type === 'IN' ? m.qty : m.movement_type === 'OUT' ? -m.qty : 0), 0);
      const [lot] = await check.unsafe(
        `SELECT COALESCE(SUM(qty_remaining), 0)::int AS q FROM scm.v_inventory_lots_open
          WHERE company_id = $1 AND source_doc_no = $2 AND item_code = $3`, [CO, GRN_NO, r.code]);
      if (net !== r.want) ok = false;
      note(`  ${r.code}: net IN minus OUT ${net} (accepted ${r.want}), open lot qty from this GRN ${lot.q}`);
      if (lot.q < r.qty) { ok = false; bad(`  ${r.code}: open lots from ${GRN_NO} hold ${lot.q}, expected at least ${r.qty}`); }
    }
    if (!ok) { bad('verification failed: the GRN does not net to its accepted qty, or its lots are short'); process.exitCode = 1; }
    else note('  every line now nets to its accepted qty');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
