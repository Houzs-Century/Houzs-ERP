#!/usr/bin/env node
/* Clear the open lots that stand above the stock balance because a stock-out took less than it shipped.
   Production read 23 Nov 2026 (Houzs-stock-lots-above-balance-2026-11-23.md, causes 3, 4, 5):

   A. DELIVERIES NEVER BACK-CHARGED (17 positions, 32 units). A DO that shipped before its stock arrived took
      nothing from the lots. The receipt is meant to back-charge it through scm.fn_reconcile_uncosted_out, but
      from 18 Aug the app called that function with the wrong parameter name and every call failed silently
      (fixed in code separately). This part calls THE SAME FUNCTION for every position that has lots above its
      balance and a short live DO OUT: it charges those DO OUTs from the open lots, oldest shipment first, at the
      lots' real cost, and is idempotent (a charged OUT has nothing left to charge). Drop-ship, cancelled and
      strict-batch DO OUTs stay out, by the function's own guards. It does not re-stamp DO / SI header costs.

   B. VOIDS AND RETURNS THAT RE-OPENED MORE THAN WAS TAKEN (5 positions, 6 units). A POS void (POS_VOID IN) or a
      consignment return (CS_DR IN) opened a full lot although the sale / ship-out it undoes took less from the
      lots. Each such IN is linked to its OUT (reverses_movement_id) and its lot is set to what the OUT took, at
      the cost it took it: exactly what the FIFO trigger (20261123T0100) now does for a new one. A return finds its
      note through its header or lines; a free-entry return (HC-CRN-2610-001 is one) is matched to the earlier,
      not-yet-undone ship-out of the same item and spec, and only when there is exactly one. Only an IN with one
      OUT to match and one untouched lot (nothing consumed from it) is repaired; anything else is refused and printed.

   MODE=plan (default) makes the changes inside a transaction, prints every row and the resulting count of
   positions above balance, then ROLLS BACK: nothing is written. MODE=apply needs
   CONFIRM="CHARGE SHORT DELIVERIES AND TRIM OVER-OPENED LOTS". Env: DATABASE_URL, MODE, CONFIRM, COMPANY (default 1).

   RE-RUN: inert. A charged DO OUT has no shortfall left; a repaired IN has reverses_movement_id set. */
import postgres from 'postgres';
import { lotsAboveBalance } from './lib/stock-lots-above-balance.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'CHARGE SHORT DELIVERIES AND TRIM OVER-OPENED LOTS';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** Positions above balance holding a live, non-drop-ship, short DO OUT — the function's own guard set. */
const DO_BUCKETS = `
  WITH pm AS (
    SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS vk,
           SUM(CASE movement_type::text WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END) AS bal
      FROM scm.inventory_movements WHERE company_id = $1 GROUP BY 1, 2, 3),
  pl AS (SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS vk, SUM(qty_remaining) AS lq
           FROM scm.inventory_lots WHERE company_id = $1 GROUP BY 1, 2, 3),
  tgt AS (SELECT pl.warehouse_id, pl.item_code, pl.vk, COALESCE(pm.bal, 0) AS bal, pl.lq
            FROM pl LEFT JOIN pm USING (warehouse_id, item_code, vk) WHERE pl.lq > GREATEST(COALESCE(pm.bal, 0), 0)),
  shorts AS (
    SELECT m.warehouse_id, m.item_code, COALESCE(m.variant_key, '') AS vk, m.source_doc_no,
           abs(m.qty) - COALESCE((SELECT sum(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id), 0) AS short
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.company_id = $1 AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO'
       AND COALESCE(d.is_dropship, FALSE) = FALSE AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED')
  SELECT t.warehouse_id::text AS warehouse_id, w.code AS wh, t.item_code, t.vk, t.bal::int AS bal, t.lq::int AS lq,
         count(*)::int AS short_lines, sum(s.short)::int AS short_units, string_agg(DISTINCT s.source_doc_no, ', ') AS docs
    FROM tgt t JOIN shorts s USING (warehouse_id, item_code, vk)
    LEFT JOIN scm.warehouses w ON w.id = t.warehouse_id
   WHERE s.short > 0
   GROUP BY t.warehouse_id, w.code, t.item_code, t.vk, t.bal, t.lq
   ORDER BY w.code, t.item_code, t.vk`;

/** POS_VOID / CS_DR INs not yet linked, with the OUT they undo and what that OUT took from the lots. */
const OVER_OPENED = `
  WITH ins AS (
    SELECT m.id, m.item_code, COALESCE(m.variant_key, '') AS vk, m.qty, m.source_doc_type::text AS t, m.source_doc_no, m.source_doc_id,
           m.created_at,
           ARRAY(SELECT r.consignment_do_id FROM scm.consignment_delivery_returns r WHERE r.id = m.source_doc_id AND r.consignment_do_id IS NOT NULL
                 UNION
                 SELECT ci.consignment_delivery_order_id FROM scm.consignment_delivery_return_items ri
                   JOIN scm.consignment_delivery_order_items ci ON ci.id = ri.consignment_do_item_id
                  WHERE ri.consignment_delivery_return_id = m.source_doc_id) AS notes
      FROM scm.inventory_movements m
     WHERE m.company_id = $1 AND m.movement_type = 'IN' AND m.reverses_movement_id IS NULL
       AND m.source_doc_type IN ('POS_VOID', 'CS_DR')),
  matched AS (
    SELECT i.*, o.id AS out_id, o.qty AS out_qty
      FROM ins i
      JOIN scm.inventory_movements o ON o.company_id = $1 AND o.movement_type = 'OUT' AND o.item_code = i.item_code
       AND ((i.t = 'POS_VOID' AND o.source_doc_type = 'POS_SALE' AND o.source_doc_no = i.source_doc_no)
         OR (i.t = 'CS_DR' AND o.source_doc_type = 'CS_DO' AND COALESCE(o.variant_key, '') = i.vk
             AND (o.source_doc_id = ANY (i.notes)
                  /* A free-entry return names no note: match only a ship-out of the same item and spec that
                     came before it and is not yet undone; more than one such ship-out is refused (judgeOver). */
                  OR (cardinality(i.notes) = 0 AND o.created_at < i.created_at
                      AND NOT EXISTS (SELECT 1 FROM scm.inventory_movements r2 WHERE r2.reverses_movement_id = o.id))))))
  SELECT x.id::text AS id, x.t, x.source_doc_no AS doc, x.item_code, x.vk, x.qty,
         count(*) OVER (PARTITION BY x.id)::int AS outs,
         x.out_id::text AS out_id, x.out_qty,
         COALESCE((SELECT sum(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = x.out_id), 0)::int AS took,
         COALESCE((SELECT sum(c.total_cost_sen) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = x.out_id), 0)::bigint AS took_cost,
         (SELECT count(*) FROM scm.inventory_lots l WHERE l.movement_id = x.id)::int AS lots,
         (SELECT min(l.id::text) FROM scm.inventory_lots l WHERE l.movement_id = x.id) AS lot_id,
         (SELECT sum(l.qty_received) FROM scm.inventory_lots l WHERE l.movement_id = x.id)::int AS lot_received,
         (SELECT sum(l.qty_remaining) FROM scm.inventory_lots l WHERE l.movement_id = x.id)::int AS lot_remaining,
         (SELECT count(*) FROM scm.inventory_lot_consumptions c JOIN scm.inventory_lots l ON l.id = c.lot_id WHERE l.movement_id = x.id)::int AS lot_used
    FROM matched x
   ORDER BY x.t, x.source_doc_no, x.item_code`;

function judgeOver(r) {
  if (r.took >= Number(r.qty)) return 'ok';
  if (r.outs !== 1) return `matches ${r.outs} stock-outs`;
  if (r.lots !== 1) return `opened ${r.lots} lots`;
  if (r.lot_used > 0) return 'its lot has been used since';
  if (r.lot_received !== Number(r.qty) || r.lot_remaining !== Number(r.qty)) return `lot ${r.lot_received}/${r.lot_remaining} does not equal the IN's ${r.qty}`;
  return null;
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (rolled back)'} company=${CO}`);
  const before = await lotsAboveBalance(sql, CO);
  note(`\n=== POSITIONS WITH LOTS ABOVE THE BALANCE, NOW: ${before.above} of ${before.positions}, ${before.units} units ===`);

  const buckets = await sql.unsafe(DO_BUCKETS, [CO]);
  note(`\n=== A. SHORT DELIVERIES IN THOSE POSITIONS: ${buckets.length} position(s), ${buckets.reduce((s, b) => s + b.short_lines, 0)} line(s), ${buckets.reduce((s, b) => s + b.short_units, 0)} unit(s) short ===`);
  for (const b of buckets) note(`  ${b.wh} | ${b.item_code}${b.vk ? ` [${b.vk.slice(0, 40)}]` : ''} | bal ${b.bal} lots ${b.lq} | ${b.short_lines} line(s) ${b.short_units} short | ${b.docs}`);

  const over = await sql.unsafe(OVER_OPENED, [CO]);
  const fix = [], refuse = [];
  for (const r of over) {
    const why = judgeOver(r);
    if (why === 'ok') continue;
    if (why) refuse.push({ ...r, why }); else fix.push(r);
  }
  note(`\n=== B. VOIDS / RETURNS THAT RE-OPENED MORE THAN WAS TAKEN: ${fix.length} to repair, ${refuse.length} refused ===`);
  for (const r of fix) note(`  FIX    ${r.t} ${r.doc} | ${r.item_code} | IN ${r.qty}, its stock-out took ${r.took} -> lot ${Math.min(Number(r.qty), r.took)}`);
  for (const r of refuse) bad(`  REFUSE ${r.t} ${r.doc} | ${r.item_code} | IN ${r.qty}, took ${r.took} — ${r.why}`);

  const ROLLBACK = new Error('plan rollback');
  let charged = 0, trimmed = 0, trimmedUnits = 0;
  try {
    await sql.begin(async (tx) => {
      for (const b of buckets) {
        const [r] = await tx.unsafe(
          `SELECT scm.fn_reconcile_uncosted_out($1::uuid, $2, $3, now(), NULL) AS n`, [b.warehouse_id, b.item_code, b.vk]);
        charged += Number(r.n ?? 0);
        note(`  A ${b.wh} | ${b.item_code} | charged ${Number(r.n ?? 0)} unit(s)`);
      }
      for (const r of fix) {
        const keep = Math.min(Number(r.qty), r.took);
        const cost = r.took > 0 ? Math.trunc(Number(r.took_cost) / r.took) : 0;
        const lot = await tx.unsafe(
          `UPDATE scm.inventory_lots SET qty_received = $2, qty_remaining = $2, unit_cost_sen = $3
            WHERE id = $1::uuid AND qty_remaining = qty_received
              AND NOT EXISTS (SELECT 1 FROM scm.inventory_lot_consumptions c WHERE c.lot_id = $1::uuid)
           RETURNING id`, [r.lot_id, keep, cost]);
        const mov = await tx.unsafe(
          `UPDATE scm.inventory_movements SET reverses_movement_id = $2::uuid, total_cost_sen = $3, unit_cost_sen = $4
            WHERE id = $1::uuid AND reverses_movement_id IS NULL RETURNING id`, [r.id, r.out_id, keep * cost, cost]);
        if (lot.length !== 1 || mov.length !== 1) throw new Error(`${r.t} ${r.doc} ${r.item_code}: lot ${lot.length} / movement ${mov.length} rows updated, expected 1 / 1`);
        trimmed += 1;
        trimmedUnits += Number(r.qty) - keep;
      }
      const inTx = await lotsAboveBalance(tx, CO);
      note(`\n=== WITH THE CHANGES IN PLACE (${APPLY ? 'committing' : 'rolled back after'}) ===`);
      note(`  A: ${charged} unit(s) charged to short deliveries from open lots`);
      note(`  B: ${trimmed} lot(s) trimmed by ${trimmedUnits} unit(s)`);
      note(`  positions with lots above the balance: ${inTx.above} of ${inTx.positions}, ${inTx.units} units (was ${before.above}, ${before.units})`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note(`\nPLAN ONLY: rolled back, nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const overAfter = (await check.unsafe(OVER_OPENED, [CO])).filter((r) => judgeOver(r) === null);
    note(`  voids / returns still re-opening more than was taken (repairable): ${overAfter.length} (was ${fix.length})`);
    for (const r of fix) {
      const [row] = await check.unsafe(
        `SELECT m.reverses_movement_id::text AS rev, l.qty_received, l.qty_remaining
           FROM scm.inventory_movements m JOIN scm.inventory_lots l ON l.movement_id = m.id WHERE m.id = $1::uuid`, [r.id]);
      const want = Math.min(Number(r.qty), r.took);
      const ok = row?.rev === r.out_id && row?.qty_remaining === want && row?.qty_received === want;
      (ok ? note : bad)(`  ${r.t} ${r.doc} ${r.item_code}: names its stock-out ${row?.rev === r.out_id ? 'yes' : 'NO'}, lot ${row?.qty_received}/${row?.qty_remaining} (want ${want})`);
      if (!ok) process.exitCode = 1;
    }
    const bucketsAfter = await check.unsafe(DO_BUCKETS, [CO]);
    note(`  positions above balance still holding a short live delivery: ${bucketsAfter.length} (was ${buckets.length})`);
    for (const b of bucketsAfter) note(`    ${b.wh} | ${b.item_code} | bal ${b.bal} lots ${b.lq} | ${b.short_units} short | ${b.docs}`);
    const after = await lotsAboveBalance(check, CO);
    note(`  positions with lots above the balance: ${after.above} of ${after.positions}, ${after.units} units (was ${before.above}, ${before.units})`);
    if (overAfter.length) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
