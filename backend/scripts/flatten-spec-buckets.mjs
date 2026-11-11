#!/usr/bin/env node
/* Flatten two spec buckets whose movement balances cancel out and that hold no
   open lot: the item total is right, the split by spec is not.

   WHY. After #5597 (run 42800733980), CODY-(K) at KL WAREHOUSE (company 2) had
   movements 2 = open lots 2 in total, but "Leg 4" stood at movements +1 and
   "Leg 4 + Total 24" at -1, both with 0 open lots. Physically there is no unit of
   either: 2990-DO-2611-016 shipped the "Leg 4" unit and the line was later
   re-specced (now blocked). The allocator reads movements per bucket
   (scm.inventory_balances), so the +1 is a phantom unit an order can be counted
   ready against. Owner approved flattening both to 0 (2026-11-10).

   WHAT IT WRITES, in one transaction (rule in lib/flatten-spec-buckets.mjs):
     - one ADJUSTMENT of -n in the plus bucket. It consumes nothing (no open lot
       there); a consumption appearing rolls the whole thing back;
     - one ADJUSTMENT of +n in the minus bucket. The FIFO trigger opens a lot for
       it, which is closed at once (qty_remaining 0, cost 0), as 0088 / 0198 /
       0291 do for a balancing row. No open lot is added and no value moves;
     - both rows: source ADJUSTMENT / SPEC-FLATTEN-<date>, reason COUNT, notes
       naming REF and REASON;
     - a request on scm.stock_allocation_recompute_queue so the worker re-reads
       readiness for the lines below within five minutes.

   REFUSES unless the two balances are exact opposites, neither bucket holds an
   open lot, and the item total (movements and open lots) does not change.

   The plan prints every bucket of the item at the warehouse before and after,
   and the open SO lines of the two buckets with their current readiness and what
   the next recompute is expected to do. Quantities and document numbers only:
   this repo's Actions logs are public, so no cost, customer or phone is printed.

   Inputs: COMPANY_ID, WAREHOUSE_ID, ITEM_CODE, FROM_VK, TO_VK (exact variant
   keys), REF (document for the notes), REASON. MODE=plan (default) writes nothing.
   MODE=apply needs CONFIRM="FLATTEN THESE TWO SPEC BUCKETS".
   Verified on a fresh connection: both buckets at movements 0 and open lots 0,
   item total unchanged, the two rows present with their notes, the opened lot
   closed, and nothing consumed by the negative row.

   RE-RUN: inert. After an apply both buckets have movements 0, which is refused
   as "nothing to flatten", so nothing is written twice. */
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { CONFIRM_PHRASE, REASON_CODE, parseInputs, planFlatten, movementNotes, projectSoLines } from './lib/flatten-spec-buckets.mjs';
import { variantKeyMirror } from './lib/ledger-repair-core.mjs';
import { SO_TERMINAL_STATES } from './lib/so-terminal-states.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

const DSN = resolveUrl();
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const MODE = (process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const parsed = parseInputs(process.env);
if (!parsed.ok) { for (const e of parsed.errors) bad(e); process.exit(2); }
const IN = parsed.input;

/* Per bucket of the item at the warehouse: movement qty with the balance view's
   signs (scm.inventory_balances) and open-lot qty. */
async function ledger(client) {
  const mov = await client`
    SELECT COALESCE(variant_key, '') AS vk,
           SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS qty
      FROM scm.inventory_movements
     WHERE company_id = ${IN.companyId} AND warehouse_id = ${IN.warehouseId} AND item_code = ${IN.itemCode}
     GROUP BY 1`;
  const lots = await client`
    SELECT COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS qty
      FROM scm.inventory_lots
     WHERE company_id = ${IN.companyId} AND warehouse_id = ${IN.warehouseId} AND item_code = ${IN.itemCode} AND qty_remaining > 0
     GROUP BY 1`;
  const out = new Map();
  for (const m of mov) out.set(m.vk, { mov: Number(m.qty), lots: 0 });
  for (const l of lots) out.set(l.vk, { mov: out.get(l.vk)?.mov ?? 0, lots: Number(l.qty) });
  return out;
}

/* Open SO lines of this item at this warehouse whose spec computes to one of the
   two buckets, in the allocator's priority order (effective delivery date, then
   SO number), with any receipt on their own PO (bound mode). */
async function soLines(client) {
  const rows = await client`
    SELECT i.id, i.doc_no, i.item_group, i.variants, i.qty, i.stock_status, i.stock_qty_ready, h.status AS so_status,
           COALESCE(h.amended_delivery_date, h.customer_delivery_date)::text AS eff_date,
           COALESCE((SELECT SUM(p.received_qty) FROM scm.purchase_order_items p
                      WHERE p.so_item_id = i.id AND p.company_id = ${IN.companyId}), 0)::int AS bound_received
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${IN.companyId}
     WHERE i.company_id = ${IN.companyId} AND i.item_code = ${IN.itemCode} AND i.warehouse_id = ${IN.warehouseId}
       AND i.cancelled = false AND h.status::text <> ALL(${SO_TERMINAL_STATES}::text[])
     ORDER BY COALESCE(h.amended_delivery_date, h.customer_delivery_date) NULLS LAST, i.doc_no, i.id`;
  return rows
    .map((r) => ({ ...r, qty: Number(r.qty), vk: variantKeyMirror(r.item_group, r.variants) }))
    .filter((r) => r.vk === IN.fromVk || r.vk === IN.toVk);
}

const short = (id) => String(id).slice(0, 8);
const side = (vk) => (vk === IN.fromVk ? 'FROM' : vk === IN.toVk ? 'TO  ' : '    ');
const tag = () => `SPEC-FLATTEN-${new Date().toISOString().slice(0, 10)}`;

function printBuckets(plan) {
  for (const [vk, b] of plan.after) {
    const was = plan.before.get(vk) ?? { mov: 0, lots: 0 };
    note(`  ${side(vk)} [${vk || '-'}] movements ${was.mov} -> ${b.mov} | open lots ${was.lots} -> ${b.lots}${b.mov === b.lots ? '' : ' (differs)'}`);
  }
  note(`  TOTAL movements ${plan.totalBefore.mov} -> ${plan.totalAfter.mov} | open lots ${plan.totalBefore.lots} -> ${plan.totalAfter.lots}`);
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${IN.companyId} warehouse=${short(IN.warehouseId)} item=${IN.itemCode}`);
  note(`  FROM_VK "${IN.fromVk}"`);
  note(`  TO_VK   "${IN.toVk}"`);
  note(`  REF ${IN.ref} | REASON ${IN.reason}`);

  const [wh] = await sql`SELECT name FROM scm.warehouses WHERE id = ${IN.warehouseId} AND company_id = ${IN.companyId}`;
  if (!wh) { bad('no such warehouse in this company'); await sql.end({ timeout: 5 }); process.exit(2); }
  note(`  warehouse ${wh.name}`);

  const before = await ledger(sql);
  const plan = planFlatten(before, IN.fromVk, IN.toVk);
  note(`\n=== ${IN.itemCode} at ${wh.name}: every bucket, before -> after ===`);
  printBuckets(plan);

  note('\n=== MOVEMENTS TO WRITE ===');
  for (const m of plan.moves) {
    note(`  ADJUSTMENT ${m.qty > 0 ? '+' : ''}${m.qty} in ${side(m.vk).trim()} [${m.vk}] reason ${REASON_CODE}${m.closesMintedLot ? '; the lot the trigger opens is closed in the same transaction' : '; consumes nothing (no open lot in this bucket)'}`);
    note(`    notes: ${movementNotes({ ...IN, vk: m.vk, qty: m.qty })}`);
  }
  for (const r of plan.refusals) bad(`  REFUSED: ${r}`);

  const lines = await soLines(sql);
  const proj = projectSoLines(lines, plan.before, plan.after);
  note(`\n=== OPEN SO LINES ON THESE TWO BUCKETS: ${lines.length} ===`);
  note('  Readiness reads scm.inventory_balances (movements, per warehouse + item + variant), not lots: this is the pool these lines draw on.');
  for (const p of proj) {
    note(`  ${side(p.vk)} ${p.doc_no} line ${short(p.id)} (SO ${p.so_status}, deliver ${p.eff_date ?? '-'}) qty ${p.qty}`
      + ` | now ${p.stock_status ?? '-'} ready ${p.readyBefore} | after ${p.statusAfter} ready ${p.readyAfter}`
      + ` | bucket ${p.poolBefore} -> ${p.poolAfter}${p.bound_received ? ` | own PO received ${p.bound_received}` : ''} | ${p.why}`);
  }
  if (lines.length === 0) note('  none: no open order is counted against either bucket, so no readiness changes.');
  note(`  lines whose readiness changes on the next recompute: ${proj.filter((p) => p.changes).length}`);

  if (!APPLY || plan.refusals.length) {
    note(plan.refusals.length ? '\nNothing written: refused.' : `\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    if (plan.refusals.length && APPLY) process.exitCode = 1;
    return;
  }

  note('\n=== WRITING ===');
  const cols = new Set((await sql`SELECT column_name FROM information_schema.columns
                                   WHERE table_schema = 'scm' AND table_name = 'inventory_movements'`).map((r) => r.column_name));
  const written = [];
  const docNo = tag();
  try {
    await sql.begin(async (tx) => {
      /* Re-plan under the write: lock the buckets' lots, re-read, refuse again. */
      await tx`SELECT id FROM scm.inventory_lots
                WHERE company_id = ${IN.companyId} AND warehouse_id = ${IN.warehouseId} AND item_code = ${IN.itemCode}
                  AND COALESCE(variant_key, '') IN (${IN.fromVk}, ${IN.toVk}) FOR UPDATE`;
      const again = planFlatten(await ledger(tx), IN.fromVk, IN.toVk);
      if (again.refusals.length) throw new Error(`changed since the plan: ${again.refusals.join('; ')}`);
      const [nm] = await tx`SELECT MAX(product_name) AS n FROM scm.inventory_movements
                             WHERE company_id = ${IN.companyId} AND item_code = ${IN.itemCode}`;
      for (const m of again.moves) {
        const row = {
          movement_type: 'ADJUSTMENT', warehouse_id: IN.warehouseId, item_code: IN.itemCode, variant_key: m.vk,
          product_name: nm?.n ?? null, qty: m.qty, unit_cost_sen: 0, source_doc_type: 'ADJUSTMENT', source_doc_no: docNo,
          reason_code: REASON_CODE, notes: movementNotes({ ...IN, vk: m.vk, qty: m.qty }), company_id: IN.companyId,
        };
        const names = Object.keys(row).filter((k) => cols.has(k));
        const vals = names.map((k) => row[k]);
        const dateSql = cols.has('movement_date') ? `, movement_date` : '';
        const dateVal = cols.has('movement_date') ? `, (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date` : '';
        const [ins] = await tx.unsafe(
          `INSERT INTO scm.inventory_movements (${names.join(', ')}${dateSql})
           VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}${dateVal}) RETURNING id`, vals);
        const [used] = await tx`SELECT COUNT(*)::int AS n FROM scm.inventory_lot_consumptions WHERE movement_id = ${ins.id}`;
        if (used.n > 0) throw new Error(`the ${m.qty} row in [${m.vk}] consumed a lot: refusing`);
        if (m.closesMintedLot) {
          const closed = await tx`UPDATE scm.inventory_lots SET qty_remaining = 0, unit_cost_sen = 0
                                   WHERE movement_id = ${ins.id} AND company_id = ${IN.companyId} AND qty_received = ${m.qty}
                                   RETURNING id`;
          if (closed.length !== 1) throw new Error(`expected exactly one lot opened by the +${m.qty} row, found ${closed.length}`);
          await tx`UPDATE scm.inventory_movements SET unit_cost_sen = 0, total_cost_sen = 0
                    WHERE id = ${ins.id} AND company_id = ${IN.companyId}`;
          written.push({ ...m, id: ins.id, lotId: closed[0].id });
        } else {
          written.push({ ...m, id: ins.id, lotId: null });
        }
      }
      await tx`INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
               VALUES ('GLOBAL', ${randomUUID()}, now(), ${`spec bucket flatten ${IN.itemCode} ${IN.ref}`})
               ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
                 requested_at = EXCLUDED.requested_at, reason = EXCLUDED.reason`;
    });
    for (const w of written) note(`  OK ADJUSTMENT ${w.qty > 0 ? '+' : ''}${w.qty} [${w.vk}] movement ${short(w.id)}${w.lotId ? `, opened lot ${short(w.lotId)} closed` : ''}`);
    note('  allocation recompute requested');
  } catch (e) {
    bad(`  FAIL: ${e.message} (rolled back, nothing written)`);
    await sql.end({ timeout: 5 });
    process.exitCode = 1;
    return;
  }
  await sql.end({ timeout: 5 });

  /* Fresh connection: check the SHAPE the write left, not the count it reported. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    let wrong = 0;
    const say = (ok, m) => { if (!ok) wrong += 1; (ok ? note : bad)(`  ${ok ? 'OK ' : 'BAD'} ${m}`); };
    const now = await ledger(check);
    for (const vk of [IN.fromVk, IN.toVk]) {
      const b = now.get(vk) ?? { mov: 0, lots: 0 };
      say(b.mov === 0 && b.lots === 0, `${side(vk).trim()} [${vk}] movements ${b.mov}, open lots ${b.lots}`);
    }
    const sum = (m, f) => [...m.values()].reduce((s, b) => s + b[f], 0);
    say(sum(now, 'mov') === plan.totalBefore.mov && sum(now, 'lots') === plan.totalBefore.lots,
      `item total movements ${plan.totalBefore.mov} -> ${sum(now, 'mov')}, open lots ${plan.totalBefore.lots} -> ${sum(now, 'lots')}`);
    for (const w of written) {
      const [mv] = await check`SELECT movement_type, qty, variant_key, notes, total_cost_sen FROM scm.inventory_movements WHERE id = ${w.id}`;
      const [used] = await check`SELECT COUNT(*)::int AS n FROM scm.inventory_lot_consumptions WHERE movement_id = ${w.id}`;
      const notesOk = String(mv?.notes ?? '').includes(IN.ref) && String(mv?.notes ?? '').includes(IN.reason);
      say(mv?.movement_type === 'ADJUSTMENT' && Number(mv?.qty) === w.qty && mv?.variant_key === w.vk && notesOk && used.n === 0
        && Number(mv?.total_cost_sen ?? 0) === 0,
        `movement ${short(w.id)} ADJUSTMENT ${w.qty} [${w.vk}], notes name ${IN.ref}: ${notesOk ? 'yes' : 'NO'}, lots consumed ${used.n}, value 0`);
      if (w.lotId) {
        const [lot] = await check`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${w.lotId}`;
        say(Number(lot?.qty_remaining) === 0, `lot ${short(w.lotId)} opened by the + row is closed (qty_remaining ${lot?.qty_remaining})`);
      }
    }
    note(`  ${wrong} check(s) failed`);
    if (wrong > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
