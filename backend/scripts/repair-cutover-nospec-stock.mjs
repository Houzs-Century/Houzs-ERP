#!/usr/bin/env node
/* Move the AutoCount cutover stock out of the no-spec bucket into the spec
   buckets the DOs since then shipped from, and cost those DOs from it.

   WHY. The cutover (2026-08-29) imported stock with no spec (the migrated GRNs
   were `migrated_no_stock`), so it sits in each item's EMPTY variant_key bucket.
   Every DO since then ships the spec, so the spec bucket goes negative and its
   DO OUTs consume nothing (uncosted), while the no-spec bucket is never touched.
   Production run 42819884842 (check-variant-key-drift.mjs, section C, company
   1): 228 of 284 negative buckets after the cutover have an empty-key sibling
   still holding the stock. Example: SQUARE PILLOW at KL. Owner approved the
   repair 2026-11-10.

   WHAT IT WRITES, per (company, item, warehouse), in ONE transaction (the rule
   is in lib/cutover-nospec-repair.mjs; oldest negative bucket first):
     - ADJUSTMENT -q in the no-spec bucket. The FIFO trigger consumes its open
       lots oldest first, at their real cost; anything but exactly q units from
       that bucket rolls the transaction back;
     - ADJUSTMENT +n in the spec bucket, one per consumed lot, so each lot the
       trigger opens carries that source lot's own cost, in the same order;
     - scm.fn_reconcile_uncosted_out over the spec bucket: the reconcile every
       stock IN runs, which costs the uncosted DO OUTs from those lots, oldest
       OUT first. It must consume exactly q and close every lot just opened, and
       each OUT must get the units the plan named, or everything rolls back;
     - a request on scm.stock_allocation_recompute_queue.
   After the commits, every DO whose OUT got cost is restamped with the
   canonical restampDoActualCost + restampSiFromDo (the same chain
   reconcileUncostedAfterIn runs), through lib/pgrest-shim.mjs.

   q is capped by what the no-spec bucket really holds (open lots AND movement
   balance, so neither goes below 0) and by what the reconcile can cost. No stock
   is invented. Buckets with another stocked spec sibling (different-value or a
   closer key) are skipped and listed.

   CLOSED MONTHS. A month is closed when it has an active STOCKADJ-<co>-<YYYY-MM>
   journal entry (acc/stock-close.ts). Costing a DO OUT dated in month M changes
   the closing value of M and every later month, so the plan lists every closed
   month from the earliest costed DO month on. APPLY refuses unless
   ALLOW_CLOSED_MONTHS=YYYY-MM,... names every one of them.

   PUBLIC LOG. This repo's Actions logs are public: the output carries document
   numbers, item codes, warehouse codes, variant keys and quantities only. No
   cost, no amount, no customer, no phone.

   Inputs: COMPANY_ID (required), CUTOVER (default 2026-08-29), ITEM_CODE
   (optional, one item only), ALLOW_CLOSED_MONTHS. MODE=plan (default) writes
   nothing. MODE=apply needs CONFIRM="MOVE CUTOVER NO-SPEC STOCK TO THE SHIPPED SPEC".
   Verified on a fresh connection: each touched no-spec bucket and spec bucket
   at its planned movements and open lots, every lot this run opened closed, and
   a re-plan of each touched item and warehouse finds nothing to do.

   RE-RUN: inert. A fixed spec bucket is back at movements 0, or its remaining
   hole has no uncosted DO OUT the reconcile may cost, or the no-spec bucket is
   exhausted: each is planned as nothing to do, so nothing is written twice. */
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { computeVariantKey } from '../src/scm/shared/variant-key.ts';
import {
  CONFIRM_PHRASE, DOC_PREFIX, REASON_CODE, SKIP, parseAllowedMonths, affectedClosedMonths, unallowedMonths,
  planItemWarehouse, movementNotes,
} from './lib/cutover-nospec-repair.mjs';
import { DEFAULT_CUTOVER, isNegativeAfterCutover } from './lib/variant-key-drift.mjs';
import { projectSoLines } from './lib/flatten-spec-buckets.mjs';
import { SO_TERMINAL_STATES } from './lib/so-terminal-states.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const say = (m) => console.log(m);

const DSN = resolveUrl();
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const MODE = (process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
if (!(Number.isInteger(CO) && CO > 0)) { bad('COMPANY_ID must be a positive integer'); process.exit(2); }
const CUTOVER = /^\d{4}-\d{2}-\d{2}$/.test(process.env.CUTOVER ?? '') ? process.env.CUTOVER : DEFAULT_CUTOVER;
const ONLY_ITEM = String(process.env.ITEM_CODE ?? '').trim() || null;
const allowed = parseAllowedMonths(process.env.ALLOW_CLOSED_MONTHS);
if (!allowed.ok) { bad(allowed.error); process.exit(2); }

const show = (vk) => (vk === '' ? '(no spec)' : vk);
const pairKey = (item, wh) => `${item}\u0001${wh}`;
const iso = (t) => (t instanceof Date ? t.toISOString() : String(t ?? ''));
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/* Every bucket of the company (or of one item): signed movement balance, open lots, last OUT. */
const bucketsOf = (client, item) => client`
  WITH mv AS (
    SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk,
           SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS net,
           MAX(created_at) FILTER (WHERE movement_type = 'OUT') AS last_out
      FROM scm.inventory_movements WHERE company_id = ${CO} AND (${item}::text IS NULL OR item_code = ${item}::text) GROUP BY 1, 2, 3),
  lt AS (
    SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS open
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0
       AND (${item}::text IS NULL OR item_code = ${item}::text) GROUP BY 1, 2, 3)
  SELECT COALESCE(mv.item_code, lt.item_code) AS "itemCode", COALESCE(mv.warehouse_id, lt.warehouse_id)::text AS "warehouseId",
         COALESCE(mv.vk, lt.vk) AS vk, COALESCE(mv.net, 0) AS "movementNet", COALESCE(lt.open, 0) AS "lotOpen", mv.last_out AS "lastOutAt"
    FROM mv FULL JOIN lt ON lt.item_code = mv.item_code AND lt.warehouse_id = mv.warehouse_id AND lt.vk = mv.vk`;

const emptyLotsOf = (client, codes) => client`
  SELECT id::text AS "lotId", item_code, warehouse_id::text AS wh, to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS received_at, qty_remaining::int AS qty,
         COALESCE(unit_cost_sen, 0)::bigint AS unit_cost_sen, variant_key AS raw_vk
    FROM scm.inventory_lots
   WHERE company_id = ${CO} AND qty_remaining > 0 AND COALESCE(variant_key, '') = '' AND item_code = ANY(${codes})`;

/* DO OUTs with every fact scm.fn_reconcile_uncosted_out decides on. A DO OUT
   with no delivery_orders row is left out: the SQL requires the row (EXISTS). */
const doOutsOf = (client, codes) => client`
  SELECT m.id::text AS id, m.item_code, m.warehouse_id::text AS wh, COALESCE(m.variant_key, '') AS vk, m.qty::int AS qty,
         to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at, m.source_doc_id::text AS do_id, COALESCE(d.do_number, m.source_doc_no) AS doc_no,
         to_char(COALESCE(m.movement_date, (m.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date), 'YYYY-MM') AS month,
         COALESCE(d.is_dropship, false) AS is_dropship, COALESCE(d.status::text, '') AS do_status,
         (m.batch_no IS NOT NULL AND EXISTS (
            SELECT 1 FROM scm.delivery_order_items di
             WHERE di.delivery_order_id = m.source_doc_id AND di.committed_po_batch_no = m.batch_no
               AND di.item_code = m.item_code AND COALESCE(di.committed_variant_key, '') = COALESCE(m.variant_key, '')
               AND di.committed_batch_strict = TRUE)) AS strict,
         COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id), 0)::int AS consumed,
         COALESCE(m.total_cost_sen, 0)::bigint AS booked_cost_sen
    FROM scm.inventory_movements m
    JOIN scm.delivery_orders d ON d.id = m.source_doc_id AND d.company_id = ${CO}
   WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO'
     AND COALESCE(m.variant_key, '') <> '' AND m.item_code = ANY(${codes})`;

/* Planner input for every (item, warehouse) holding a negative spec bucket and a stocked no-spec bucket. */
async function gather(client, item) {
  const buckets = await bucketsOf(client, item);
  const byPair = new Map();
  for (const b of buckets) {
    const k = pairKey(b.itemCode, b.warehouseId);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(b);
  }
  const negatives = buckets.filter((b) => b.vk !== '' && isNegativeAfterCutover(b, CUTOVER));
  const pairs = new Map();
  let outOfScope = 0;
  for (const n of negatives) {
    const k = pairKey(n.itemCode, n.warehouseId);
    const empty = byPair.get(k).find((b) => b.vk === '');
    if (!empty || Number(empty.lotOpen) <= 0) { outOfScope += 1; continue; }
    if (!pairs.has(k)) pairs.set(k, { itemCode: n.itemCode, warehouseId: n.warehouseId, all: byPair.get(k), empty, negs: [] });
    pairs.get(k).negs.push(n);
  }
  const codes = [...new Set([...pairs.values()].map((p) => p.itemCode))];
  const lots = codes.length ? await emptyLotsOf(client, codes) : [];
  const outs = codes.length ? await doOutsOf(client, codes) : [];
  const cutoffTs = new Date().toISOString();
  const inputs = new Map();
  for (const [k, p] of pairs) {
    const negVks = new Set(p.negs.map((n) => n.vk));
    const mine = outs.filter((o) => o.item_code === p.itemCode && o.wh === p.warehouseId && negVks.has(o.vk));
    inputs.set(k, {
      itemCode: p.itemCode, warehouseId: p.warehouseId,
      input: {
        cutoffTs,
        empty: {
          mov: Number(p.empty.movementNet),
          lots: lots.filter((l) => l.item_code === p.itemCode && l.wh === p.warehouseId).map((l) => ({
            lotId: l.lotId, receivedAt: iso(l.received_at), qtyRemaining: Number(l.qty), unitCostSen: Number(l.unit_cost_sen), rawVk: l.raw_vk,
          })),
        },
        negatives: p.negs.map((n) => {
          const o = mine.filter((x) => x.vk === n.vk);
          const after = o.map((x) => iso(x.created_at)).filter((t) => t >= CUTOVER).sort();
          return {
            vk: n.vk, mov: Number(n.movementNet), lotOpen: Number(n.lotOpen), firstOutAt: after[0] ?? iso(n.lastOutAt),
            outs: o.map((x) => ({
              movementId: x.id, doId: x.do_id, qty: Number(x.qty), createdAt: iso(x.created_at), isDropship: x.is_dropship,
              strictBatchCommitted: x.strict, doStatus: x.do_status, alreadyConsumedQty: Number(x.consumed),
              alreadyCostedSen: Number(x.booked_cost_sen), docNo: x.doc_no, month: x.month,
            })),
          };
        }),
        stocked: p.all.filter((b) => Number(b.lotOpen) > 0).map((b) => ({ vk: b.vk, lotOpen: Number(b.lotOpen) })),
      },
    });
  }
  return { inputs, negativeCount: negatives.length, outOfScope };
}

async function closedMonths(client) {
  const rows = await client`
    SELECT source_doc_no FROM scm.journal_entries
     WHERE company_id = ${CO} AND source_type = 'STOCKADJ'
       AND COALESCE(reversed, false) = false AND COALESCE(posted, true) = true`;
  const re = new RegExp(`^STOCKADJ-${CO}-(\\d{4}-\\d{2})$`);
  return [...new Set(rows.map((r) => re.exec(String(r.source_doc_no ?? ''))?.[1]).filter(Boolean))].sort();
}

/* Open SO lines on the touched buckets, in the allocator's priority order. */
async function soLinesOf(client, codes) {
  if (!codes.length) return [];
  const rows = await client`
    SELECT i.id, i.doc_no, i.item_code, i.warehouse_id::text AS wh, i.item_group, i.variants, i.qty, i.stock_status, i.stock_qty_ready,
           COALESCE((SELECT SUM(p.received_qty) FROM scm.purchase_order_items p
                      WHERE p.so_item_id = i.id AND p.company_id = ${CO}), 0)::int AS bound_received
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}
     WHERE i.company_id = ${CO} AND i.item_code = ANY(${codes}) AND i.cancelled = false
       AND h.status::text <> ALL(${SO_TERMINAL_STATES}::text[])
     ORDER BY COALESCE(h.amended_delivery_date, h.customer_delivery_date) NULLS LAST, i.doc_no, i.id`;
  return rows.map((r) => ({
    ...r, qty: Number(r.qty),
    vk: computeVariantKey(r.item_group, r.variants && typeof r.variants === 'object' ? r.variants : {}),
  }));
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} cutover=${CUTOVER}${ONLY_ITEM ? ` item=${ONLY_ITEM}` : ''}`);
  const whRows = await sql`SELECT id::text AS id, COALESCE(code, name) AS code FROM scm.warehouses WHERE company_id = ${CO}`;
  const whName = new Map(whRows.map((w) => [w.id, w.code]));

  const { inputs, negativeCount, outOfScope } = await gather(sql, ONLY_ITEM);
  const plans = new Map();
  for (const [k, x] of inputs) plans.set(k, { ...x, plan: planItemWarehouse(x.input) });

  /* ---- per item and warehouse ---- */
  const soLines = await soLinesOf(sql, [...new Set([...plans.values()].filter((p) => p.plan.fixes.length).map((p) => p.itemCode))]);
  let readinessChanges = 0;
  const costedMonths = [];
  const skipTally = new Map();
  for (const p of plans.values()) {
    const { plan } = p;
    for (const s of plan.skips) skipTally.set(s.code, (skipTally.get(s.code) ?? 0) + 1);
    if (!plan.fixes.length && !plan.skips.length) continue;
    say(`\n=== ${p.itemCode} @ ${whName.get(p.warehouseId) ?? p.warehouseId.slice(0, 8)} ===`);
    say(`  (no spec) movements ${plan.emptyBefore.mov} -> ${plan.emptyAfter.mov} | open lots ${plan.emptyBefore.lots} -> ${plan.emptyAfter.lots}`);
    for (const f of plan.fixes) {
      say(`  FIX  [${f.vk}] movements ${f.before.mov} -> ${f.after.mov} | open lots ${f.before.lots} -> ${f.after.lots} | moves ${f.qty}${f.capped ? ` (capped: ${f.residual} unit(s) stay negative)` : ''} from ${f.takes.length} lot(s)`);
      for (const c of f.costed) {
        costedMonths.push(c.month);
        say(`       DO OUT costed: ${c.docNo} x${c.qty} (${c.month}${c.createdAt && c.createdAt < CUTOVER ? ', before cutover' : ''})${c.stillShort ? `, ${c.stillShort} still uncosted` : ''}`);
      }
    }
    for (const s of p.plan.skips) say(`  SKIP [${s.vk}] movements ${s.before.mov}: ${s.why}${s.sibling ? ` (sibling ${show(s.sibling)}${s.cls ? `, ${s.cls}` : ''})` : ''}`);
    if (plan.fixes.length) {
      const before = new Map([['', { mov: plan.emptyBefore.mov }], ...plan.fixes.map((f) => [f.vk, { mov: f.before.mov }])]);
      const after = new Map([['', { mov: plan.emptyAfter.mov }], ...plan.fixes.map((f) => [f.vk, { mov: f.after.mov }])]);
      const lines = soLines.filter((l) => l.item_code === p.itemCode && l.wh === p.warehouseId && before.has(l.vk));
      for (const l of projectSoLines(lines, before, after).filter((x) => x.changes)) {
        readinessChanges += 1;
        say(`  SO   ${l.doc_no} [${show(l.vk)}] qty ${l.qty}: ready ${l.readyBefore} -> ${l.readyAfter} (${l.why})`);
      }
    }
  }

  /* ---- totals ---- */
  const all = [...plans.values()];
  const fixes = all.flatMap((p) => p.plan.fixes);
  const closed = await closedMonths(sql);
  const affected = affectedClosedMonths(costedMonths, closed);
  note(`\n=== TOTALS company ${CO} ===`);
  note(`  negative spec buckets after ${CUTOVER}: ${negativeCount}; with no stocked no-spec sibling (out of scope): ${outOfScope}`);
  note(`  buckets fixed: ${fixes.length} (${fixes.filter((f) => f.capped).length} capped); units moved: ${fixes.reduce((s, f) => s + f.qty, 0)}; items x warehouses: ${all.filter((p) => p.plan.fixes.length).length}`);
  note(`  DO OUTs that become costed: ${fixes.reduce((s, f) => s + f.costed.length, 0)} (units ${fixes.reduce((s, f) => s + f.costed.reduce((t, c) => t + c.qty, 0), 0)})`);
  note(`  buckets skipped: ${[...skipTally.values()].reduce((s, n) => s + n, 0)}`);
  for (const [code, n] of [...skipTally].sort((a, b) => b[1] - a[1])) note(`    ${n}  ${code}: ${SKIP[code]}`);
  note(`  open SO lines whose readiness changes: ${readinessChanges}`);
  note(`  closed stock months: ${closed.join(', ') || 'none'}`);
  note(`  closed months this repair changes: ${affected.join(', ') || 'none'}`);
  const missing = unallowedMonths(affected, allowed.months);
  if (missing.length) note(`  APPLY needs ALLOW_CLOSED_MONTHS=${affected.join(',')} (not yet allowed: ${missing.join(', ')})`);

  if (!APPLY || fixes.length === 0) {
    note(fixes.length ? `\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".` : '\nNothing to repair.');
    await sql.end({ timeout: 5 });
    return;
  }
  if (missing.length) {
    bad(`REFUSED: the repair changes closed stock month(s) ${missing.join(', ')}. Set ALLOW_CLOSED_MONTHS to name them once the owner agrees.`);
    await sql.end({ timeout: 5 });
    process.exitCode = 1;
    return;
  }

  /* ---- write, one transaction per item and warehouse ---- */
  note('\n=== WRITING ===');
  const docNo = `${DOC_PREFIX}-${today()}`;
  const cols = new Set((await sql`SELECT column_name FROM information_schema.columns
                                   WHERE table_schema = 'scm' AND table_name = 'inventory_movements'`).map((r) => r.column_name));
  const insertMovement = async (tx, row) => {
    const names = Object.keys(row).filter((k) => cols.has(k));
    const dateSql = cols.has('movement_date') ? ', movement_date' : '';
    const dateVal = cols.has('movement_date') ? `, (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date` : '';
    const [ins] = await tx.unsafe(`INSERT INTO scm.inventory_movements (${names.join(', ')}${dateSql})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}${dateVal}) RETURNING id`, names.map((k) => row[k]));
    return ins.id;
  };
  const done = [];
  const affectedDoIds = new Set();
  for (const [k, p] of plans) {
    if (!p.plan.fixes.length) continue;
    const label = `${p.itemCode} @ ${whName.get(p.warehouseId) ?? p.warehouseId.slice(0, 8)}`;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM scm.inventory_lots WHERE company_id = ${CO} AND item_code = ${p.itemCode}
                  AND warehouse_id = ${p.warehouseId} FOR UPDATE`;
        const again = (await gather(tx, p.itemCode)).inputs.get(k);
        const plan = again ? planItemWarehouse(again.input) : null;
        const sig = (pl) => JSON.stringify(pl?.fixes.map((f) => [f.vk, f.qty, f.costed.map((c) => [c.movementId, c.qty])]) ?? []);
        if (sig(plan) !== sig(p.plan)) throw new Error('changed since the plan');
        const [nm] = await tx`SELECT MAX(product_name) AS n FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ${p.itemCode}`;
        const base = { movement_type: 'ADJUSTMENT', warehouse_id: p.warehouseId, item_code: p.itemCode, product_name: nm?.n ?? null,
          source_doc_type: 'ADJUSTMENT', source_doc_no: docNo, reason_code: REASON_CODE, company_id: CO };
        for (const f of plan.fixes) {
          const outId = await insertMovement(tx, { ...base, variant_key: '', qty: -f.qty, unit_cost_sen: 0,
            notes: movementNotes({ side: 'from', qty: -f.qty, specVk: f.vk, ref: docNo }) });
          const used = await tx`
            SELECT c.lot_id::text AS lot_id, c.qty_consumed::int AS qty, COALESCE(l.unit_cost_sen, 0)::bigint AS unit_cost_sen
              FROM scm.inventory_lot_consumptions c JOIN scm.inventory_lots l ON l.id = c.lot_id
             WHERE c.movement_id = ${outId} AND l.company_id = ${CO} AND COALESCE(l.variant_key, '') = ''
             ORDER BY l.received_at, l.id`;
          const sigUsed = JSON.stringify(used.map((u) => [u.lot_id, u.qty]));
          if (sigUsed !== JSON.stringify(f.takes.map((t) => [t.lotId, t.qty]))) throw new Error(`the -${f.qty} row consumed other lots than planned`);
          const minted = [];
          for (const [i, u] of used.entries()) {
            const inId = await insertMovement(tx, { ...base, variant_key: f.vk, qty: u.qty, unit_cost_sen: u.unit_cost_sen,
              notes: movementNotes({ side: 'to', qty: u.qty, specVk: f.vk, ref: docNo }) });
            /* Stamp the source lot's own cost (the trigger would average a 0) and
               its order, so the reconcile walks these lots as the plan did. */
            const lot = await tx`UPDATE scm.inventory_lots
                                    SET unit_cost_sen = ${u.unit_cost_sen}, received_at = (SELECT s.received_at FROM scm.inventory_lots s WHERE s.id = ${u.lot_id}::uuid) + make_interval(secs => ${i}::int / 1000000.0)
                                  WHERE movement_id = ${inId} AND company_id = ${CO} AND qty_received = ${u.qty} RETURNING id::text AS id`;
            if (lot.length !== 1) throw new Error(`expected one lot opened by a +${u.qty} row, found ${lot.length}`);
            await tx`UPDATE scm.inventory_movements SET unit_cost_sen = ${u.unit_cost_sen}, total_cost_sen = ${u.qty * Number(u.unit_cost_sen)}
                      WHERE id = ${inId} AND company_id = ${CO}`;
            minted.push(lot[0].id);
          }
          const [r] = await tx`SELECT scm.fn_reconcile_uncosted_out(${p.warehouseId}::uuid, ${p.itemCode}::text, ${f.vk}::text, now(), NULL::uuid)::int AS n`;
          if (Number(r.n) !== f.qty) throw new Error(`the reconcile costed ${r.n} unit(s), the plan ${f.qty}`);
          const [open] = await tx`SELECT COALESCE(SUM(qty_remaining), 0)::int AS n FROM scm.inventory_lots WHERE id = ANY(${minted}::uuid[])`;
          if (open.n !== 0) throw new Error(`${open.n} unit(s) left open on the lots this run opened`);
          const got = await tx`SELECT movement_id::text AS id, SUM(qty_consumed)::int AS qty FROM scm.inventory_lot_consumptions
                                WHERE lot_id = ANY(${minted}::uuid[]) GROUP BY 1 ORDER BY 1`;
          const want = [...f.costed].sort((a, b) => (a.movementId < b.movementId ? -1 : 1)).map((c) => [c.movementId, c.qty]);
          if (JSON.stringify(got.map((g) => [g.id, g.qty])) !== JSON.stringify(want)) throw new Error('the reconcile costed other DO OUTs than planned');
          for (const c of f.costed) affectedDoIds.add(c.doId);
        }
        await tx`INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
                 VALUES ('GLOBAL', ${randomUUID()}, now(), ${`cutover no-spec repair ${p.itemCode}`})
                 ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
                   requested_at = EXCLUDED.requested_at, reason = EXCLUDED.reason`;
      });
      done.push(k);
      note(`  OK   ${label}: ${p.plan.fixes.length} bucket(s), ${p.plan.moved} unit(s)`);
    } catch (e) {
      bad(`  FAIL ${label}: ${e.message} (rolled back, nothing written for it)`);
      process.exitCode = 1;
    }
  }
  note(`  committed: ${done.length} of ${[...plans.values()].filter((p) => p.plan.fixes.length).length} item(s) x warehouse(s)`);

  /* ---- DO lines + Sales Invoices, as reconcileUncostedAfterIn does after a reconcile ---- */
  if (affectedDoIds.size) {
    note(`\n=== RESTAMPING ${affectedDoIds.size} DO(s) (restampDoActualCost + restampSiFromDo) ===`);
    const { restampDoActualCost } = await import('../src/scm/routes/delivery-orders-mfg.ts');
    const { restampSiFromDo } = await import('../src/scm/lib/recost.ts');
    const { pgrestShim } = await import('./lib/pgrest-shim.mjs');
    const sb = pgrestShim(sql, 'scm');
    let failed = 0;
    for (const doId of affectedDoIds) {
      try {
        await restampDoActualCost(sb, doId);
        await restampSiFromDo(sb, doId);
        if (sb.__gaps.length) throw new Error(`shim gap: ${sb.__gaps.join('; ')}`);
      } catch (e) { failed += 1; bad(`  restamp ${doId.slice(0, 8)}: ${e.message}`); }
    }
    note(`  restamped ${affectedDoIds.size - failed} of ${affectedDoIds.size}${failed ? ' — re-run restamp-do-actual-cost.mjs for the failed ones' : ''}`);
    if (failed) process.exitCode = 1;
  }
  await sql.end({ timeout: 5 });

  /* ---- fresh connection: the SHAPE the writes left ---- */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    let wrong = 0;
    const ok = (good, m) => { if (!good) wrong += 1; (good ? note : bad)(`  ${good ? 'OK ' : 'BAD'} ${m}`); };
    for (const k of done) {
      const p = plans.get(k);
      const label = `${p.itemCode} @ ${whName.get(p.warehouseId) ?? p.warehouseId.slice(0, 8)}`;
      const now = await bucketsOf(check, p.itemCode);
      const at = (vk) => now.find((b) => b.warehouseId === p.warehouseId && b.vk === vk) ?? { movementNet: 0, lotOpen: 0 };
      const e = at('');
      ok(Number(e.movementNet) === p.plan.emptyAfter.mov && Number(e.lotOpen) === p.plan.emptyAfter.lots && Number(e.movementNet) >= 0,
        `${label} (no spec): movements ${e.movementNet}, open lots ${e.lotOpen} (planned ${p.plan.emptyAfter.mov} / ${p.plan.emptyAfter.lots})`);
      for (const f of p.plan.fixes) {
        const b = at(f.vk);
        ok(Number(b.movementNet) === f.after.mov && Number(b.lotOpen) === 0, `${label} [${f.vk}]: movements ${b.movementNet}, open lots ${b.lotOpen} (planned ${f.after.mov} / 0)`);
      }
      const again = (await gather(check, p.itemCode)).inputs.get(k);
      const left = again ? planItemWarehouse(again.input).fixes.length : 0;
      ok(left === 0, `${label}: a re-plan finds ${left} bucket(s) to fix`);
    }
    const [mintedOpen] = await check`
      SELECT COUNT(*)::int AS n FROM scm.inventory_lots l JOIN scm.inventory_movements m ON m.id = l.movement_id
       WHERE m.company_id = ${CO} AND m.source_doc_no = ${docNo} AND m.qty > 0 AND l.qty_remaining > 0`;
    ok(mintedOpen.n === 0, `lots opened by ${docNo} still open: ${mintedOpen.n}`);
    note(`  ${wrong} check(s) failed`);
    if (wrong > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
