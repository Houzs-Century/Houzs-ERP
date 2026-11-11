#!/usr/bin/env node
/* Revert the cutover no-spec repair, production run 42827135058, for one company.

   WHY. repair-cutover-nospec-stock.mjs (#5611) ran on 2026-11-10 for company 1
   (Houzs Century): 24 item x warehouse, the no-spec cutover stock moved into the
   spec buckets and 37 DO OUTs (38 units) costed from it, 30 DOs and their SIs
   restamped, closed months 2026-09 and 2026-10 allowed. Owner instruction the
   same day: revert it. Houzs binds each SO line to a PO line and does not track
   stock by spec, so the repair should not have run for company 1.

   WHAT IT WRITES, per item x warehouse, in ONE transaction (the rule and the
   exact list of the repair's rows are in lib/cutover-nospec-revert.mjs):
     - deletes the consumptions scm.fn_reconcile_uncosted_out wrote on the lots
       the repair opened, and gives those lots their units back;
     - each costed DO OUT back to its prior cost: total_cost_sen minus what the
       reconcile added, unit_cost_sen = that / ABS(qty). Those are the only two
       columns the reconcile changes (20261026T1600);
     - deletes the consumptions of the repair's no-spec -q row and gives each
       original no-spec lot its units back; that row re-costed from what remains
       of its consumptions (0);
     - ADJUSTMENT -q in the spec bucket (the trigger consumes exactly the lots the
       repair opened) and ADJUSTMENT +q in the no-spec bucket at cost 0 with its
       lot closed, both with notes naming run 42827135058 and the repair row;
     - a request on scm.stock_allocation_recompute_queue.
   The repair's own rows stay, as history. After the commits the same DOs are
   restamped with restampDoActualCost + restampSiFromDo through
   lib/pgrest-shim.mjs, as the repair did.

   REFUSED, the whole run, listing why: anything written after the repair in a
   touched bucket (a new DO, GRN, transfer, adjustment), a lot the repair opened
   that was given units back or drawn by anything but the run's reconcile, rows
   that are not the shape the repair writes, or an after-revert state that would
   not equal the pre-repair state exactly.

   PLAN prints, per item x warehouse and bucket: movements / open lots now, after
   the revert and before the repair (the last two must match); each DO OUT going
   back to uncosted; and the closed months the revert changes. CLOSED MONTHS:
   taking cost off a DO OUT dated in month M changes the closing value of M and
   every later month, so APPLY needs ALLOW_CLOSED_MONTHS naming every one
   (expected 2026-09,2026-10). The nightly stock close re-posts them.

   PUBLIC LOG. Actions logs are public: document numbers, item codes, warehouse
   codes, variant keys and quantities only. No cost, no amount, no customer.

   Inputs: COMPANY_ID (required), ITEM_CODE (optional, one item),
   ALLOW_CLOSED_MONTHS. MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="REVERT THE CUTOVER NO-SPEC REPAIR".
   Verified on a fresh connection: every touched bucket at its pre-repair
   movements and open lots, every no-spec lot at its pre-repair qty_remaining,
   every lot the repair opened closed, every reset DO OUT at its prior cost with
   no consumption on those lots, and a re-plan finds nothing to revert.

   RE-RUN: inert. Each revert row carries "repair row <id>" for the repair row it
   balances; a group with such a row is planned as already reverted and nothing
   is written twice. A failed item x warehouse rolled back and is picked up again. */
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  REVERT_CONFIRM_PHRASE, REPAIR_DOC_NO, REPAIR_NOTES_PREFIX, REPAIR_RUN_ID, REVERT_DOC_PREFIX, REVERT_REASON_CODE,
  groupRepairRows, revertMarker, revertNotes, planPair, planSignature,
} from './lib/cutover-nospec-revert.mjs';
import { parseAllowedMonths, affectedClosedMonths, unallowedMonths } from './lib/cutover-nospec-repair.mjs';

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
if (APPLY && process.env.CONFIRM !== REVERT_CONFIRM_PHRASE) { bad(`MODE=apply requires CONFIRM="${REVERT_CONFIRM_PHRASE}"`); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
if (!(Number.isInteger(CO) && CO > 0)) { bad('COMPANY_ID must be a positive integer'); process.exit(2); }
const ONLY_ITEM = String(process.env.ITEM_CODE ?? '').trim() || null;
const allowed = parseAllowedMonths(process.env.ALLOW_CLOSED_MONTHS);
if (!allowed.ok) { bad(allowed.error); process.exit(2); }

/* The repair's day, Malaysia time: its rows were written then, under its doc number. */
const RUN_DAY = REPAIR_DOC_NO.slice(-10);
const WINDOW_FROM = `${RUN_DAY}T00:00:00+08:00`;
const WINDOW_TO = new Date(Date.parse(WINDOW_FROM) + 24 * 3600_000).toISOString();
const TS = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;
const show = (vk) => (vk === '' ? '(no spec)' : vk);
const pairKey = (item, wh) => `${item}\u0001${wh}`;
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

const movementCols = (client, where) => client.unsafe(`
  SELECT id::text AS id, item_code AS "itemCode", warehouse_id::text AS "warehouseId", COALESCE(variant_key, '') AS vk,
         qty::int AS qty, COALESCE(unit_cost_sen, 0)::bigint AS "unitCostSen", COALESCE(total_cost_sen, 0)::bigint AS "totalCostSen",
         notes, COALESCE(source_doc_no, '') AS "docNo", movement_type::text AS "movementType",
         to_char(created_at AT TIME ZONE 'UTC', ${TS}) AS "createdAt"
    FROM scm.inventory_movements WHERE ${where.sql}`, where.args);

/* Everything the plan decides on, for the company or one item. */
async function gather(client, item) {
  const repairRows = await movementCols(client, {
    sql: `company_id = $1 AND movement_type = 'ADJUSTMENT' AND source_doc_type = 'ADJUSTMENT' AND source_doc_no = $2
          AND notes LIKE $3 AND created_at >= $4::timestamptz AND created_at < $5::timestamptz AND ($6::text IS NULL OR item_code = $6::text)`,
    args: [CO, REPAIR_DOC_NO, `${REPAIR_NOTES_PREFIX}%`, WINDOW_FROM, WINDOW_TO, item],
  });
  const revertRows = await movementCols(client, {
    sql: `company_id = $1 AND movement_type = 'ADJUSTMENT' AND source_doc_no LIKE $2 AND notes LIKE $3
          AND ($4::text IS NULL OR item_code = $4::text)`,
    args: [CO, `${REVERT_DOC_PREFIX}-%`, `%run ${REPAIR_RUN_ID}%`, item],
  });
  const { groups: rawGroups, problems: shapeProblems } = groupRepairRows(repairRows.map((r) => ({ ...r, qty: Number(r.qty) })));
  const fromIds = rawGroups.map((g) => g.from[0].id);
  const toIds = rawGroups.flatMap((g) => g.to.map((t) => t.id));
  const ownIds = [...repairRows.map((r) => r.id), ...revertRows.map((r) => r.id)];

  const fromCons = fromIds.length ? await client`
    SELECT c.id::text AS id, c.lot_id::text AS "lotId", c.movement_id::text AS "movementId", c.qty_consumed::int AS qty,
           COALESCE(c.unit_cost_sen, 0)::bigint AS "unitCostSen"
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_movements m ON m.id = c.movement_id AND m.company_id = ${CO}
     WHERE c.movement_id = ANY(${fromIds}::uuid[])` : [];
  const lotIds = [...new Set(fromCons.map((c) => c.lotId))];
  const lots = (lotIds.length || ownIds.length) ? await client`
    SELECT id::text AS "lotId", movement_id::text AS "movementId", COALESCE(variant_key, '') AS vk,
           qty_received::int AS "qtyReceived", qty_remaining::int AS "qtyRemaining"
      FROM scm.inventory_lots
     WHERE company_id = ${CO} AND (id = ANY(${lotIds}::uuid[]) OR movement_id = ANY(${ownIds}::uuid[]))` : [];
  const toSet = new Set(toIds);
  const minted = lots.filter((l) => toSet.has(l.movementId));
  const mintedIds = minted.map((l) => l.lotId);
  const [ctype] = await client`SELECT data_type FROM information_schema.columns
                                WHERE table_schema = 'scm' AND table_name = 'inventory_lot_consumptions' AND column_name = 'consumed_at'`;
  const consumedAtSql = String(ctype?.data_type ?? '').startsWith('timestamp') ? '(extract(epoch FROM c.consumed_at) * 1000)::float8' : 'NULL::float8';
  const mintedCons = mintedIds.length ? await client.unsafe(`
    SELECT c.id::text AS id, c.lot_id::text AS "lotId", c.movement_id::text AS "movementId", c.qty_consumed::int AS qty,
           COALESCE(c.total_cost_sen, c.qty_consumed * COALESCE(c.unit_cost_sen, 0))::bigint AS "totalCostSen",
           CASE WHEN m.id IS NULL THEN 'MISSING' WHEN m.company_id <> $1 THEN 'OTHER-COMPANY' ELSE m.movement_type::text END AS "movementType",
           COALESCE(m.source_doc_type, '') AS "sourceDocType",
           to_char(m.created_at AT TIME ZONE 'UTC', ${TS}) AS "movementCreatedAt", ${consumedAtSql} AS "consumedAt"
      FROM scm.inventory_lot_consumptions c
      LEFT JOIN scm.inventory_movements m ON m.id = c.movement_id
     WHERE c.lot_id = ANY($2::uuid[])`, [CO, mintedIds]) : [];
  const outIds = [...new Set(mintedCons.filter((c) => c.movementType === 'OUT').map((c) => c.movementId))];
  const outs = outIds.length ? await client`
    SELECT m.id::text AS "movementId", m.qty::int AS qty, COALESCE(m.total_cost_sen, 0)::bigint AS "totalCostSen",
           m.source_doc_id::text AS "doId", COALESCE(d.do_number, m.source_doc_no) AS "docNo",
           to_char(COALESCE(m.movement_date, (m.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date), 'YYYY-MM') AS month,
           COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id), 0)::int AS "consumedQty"
      FROM scm.inventory_movements m
      LEFT JOIN scm.delivery_orders d ON d.id = m.source_doc_id AND d.company_id = ${CO}
     WHERE m.company_id = ${CO} AND m.id = ANY(${outIds}::uuid[])` : [];

  const items = [...new Set(rawGroups.map((g) => g.itemCode))];
  const firstTs = rawGroups.map((g) => g.from[0].createdAt).sort()[0];
  const laterRows = items.length ? await movementCols(client, {
    sql: `company_id = $1 AND item_code = ANY($2::text[]) AND created_at > ($3::timestamp AT TIME ZONE 'UTC')`,
    args: [CO, items, firstTs],
  }) : [];
  const buckets = items.length ? await client`
    WITH mv AS (
      SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk,
             SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS net
        FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ANY(${items}) GROUP BY 1, 2, 3),
    lt AS (
      SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS open
        FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0 AND item_code = ANY(${items}) GROUP BY 1, 2, 3)
    SELECT COALESCE(mv.item_code, lt.item_code) AS "itemCode", COALESCE(mv.warehouse_id, lt.warehouse_id)::text AS "warehouseId",
           COALESCE(mv.vk, lt.vk) AS vk, COALESCE(mv.net, 0) AS mov, COALESCE(lt.open, 0) AS lots
      FROM mv FULL JOIN lt ON lt.item_code = mv.item_code AND lt.warehouse_id = mv.warehouse_id AND lt.vk = mv.vk` : [];

  /* ---- assemble per item x warehouse ---- */
  const ownSet = new Set(ownIds);
  const lotById = new Map(lots.map((l) => [l.lotId, l]));
  const pairs = new Map();
  for (const rg of rawGroups) {
    const k = pairKey(rg.itemCode, rg.warehouseId);
    if (!pairs.has(k)) pairs.set(k, { itemCode: rg.itemCode, warehouseId: rg.warehouseId, groups: [] });
    const from = rg.from[0];
    const myCons = fromCons.filter((c) => c.movementId === from.id).map((c) => ({ ...c, qty: Number(c.qty), unitCostSen: Number(c.unitCostSen) }));
    const myTo = new Set(rg.to.map((t) => t.id));
    const myMinted = minted.filter((l) => myTo.has(l.movementId));
    const myMintedIds = new Set(myMinted.map((l) => l.lotId));
    const myMintedCons = mintedCons.filter((c) => myMintedIds.has(c.lotId)).map((c) => ({ ...c, qty: Number(c.qty), totalCostSen: Number(c.totalCostSen) }));
    const myOutIds = new Set(myMintedCons.map((c) => c.movementId));
    const vks = new Set(['', rg.specVk]);
    pairs.get(k).groups.push({
      itemCode: rg.itemCode, warehouseId: rg.warehouseId, specVk: rg.specVk,
      from: { id: from.id, qty: Number(from.qty), totalCostSen: Number(from.totalCostSen), createdAt: from.createdAt },
      to: rg.to.map((t) => ({ id: t.id, qty: Number(t.qty), unitCostSen: Number(t.unitCostSen) })),
      reverted: revertRows.some((r) => String(r.notes ?? '').includes(revertMarker(from.id))),
      fromConsumptions: myCons,
      emptyLots: [...new Set(myCons.map((c) => c.lotId))].map((id) => lotById.get(id)).filter(Boolean)
        .map((l) => ({ lotId: l.lotId, vk: l.vk, qtyReceived: Number(l.qtyReceived), qtyRemaining: Number(l.qtyRemaining) })),
      mintedLots: myMinted.map((l) => ({ lotId: l.lotId, movementId: l.movementId, vk: l.vk, qtyReceived: Number(l.qtyReceived), qtyRemaining: Number(l.qtyRemaining) })),
      mintedConsumptions: myMintedCons,
      outs: outs.filter((o) => myOutIds.has(o.movementId)).map((o) => ({ ...o, qty: Number(o.qty), totalCostSen: Number(o.totalCostSen), consumedQty: Number(o.consumedQty) })),
      later: laterRows.filter((m) => m.itemCode === rg.itemCode && m.warehouseId === rg.warehouseId && vks.has(m.vk)
        && m.createdAt > from.createdAt && !ownSet.has(m.id) && !m.docNo.startsWith(`${REVERT_DOC_PREFIX}-`))
        .map((m) => ({ id: m.id, movementType: m.movementType, docNo: m.docNo, vk: m.vk, qty: Number(m.qty), createdAt: m.createdAt })),
    });
  }
  const result = new Map();
  for (const [k, p] of pairs) {
    const now = new Map(buckets.filter((b) => b.itemCode === p.itemCode && b.warehouseId === p.warehouseId)
      .map((b) => [b.vk, { mov: Number(b.mov), lots: Number(b.lots) }]));
    const own = [...repairRows, ...revertRows].filter((r) => r.itemCode === p.itemCode && r.warehouseId === p.warehouseId);
    const ownMovIds = new Set(own.map((r) => r.id));
    const pairFromIds = new Set(p.groups.map((g) => g.from.id));
    const planned = planPair({
      groups: p.groups,
      now,
      ownRows: own.map((r) => ({ vk: r.vk, qty: Number(r.qty) })),
      ownLots: lots.filter((l) => ownMovIds.has(l.movementId)).map((l) => ({ vk: l.vk, qtyRemaining: Number(l.qtyRemaining) })),
      drawnByRepair: fromCons.filter((c) => pairFromIds.has(c.movementId)).map((c) => ({ vk: lotById.get(c.lotId)?.vk ?? '', qty: Number(c.qty) })),
    });
    result.set(k, { ...p, ...planned });
  }
  return { pairs: result, shapeProblems, repairRowCount: repairRows.length };
}

async function closedMonths(client) {
  const rows = await client`
    SELECT source_doc_no FROM scm.journal_entries
     WHERE company_id = ${CO} AND source_type = 'STOCKADJ'
       AND COALESCE(reversed, false) = false AND COALESCE(posted, true) = true`;
  const re = new RegExp(`^STOCKADJ-${CO}-(\\d{4}-\\d{2})$`);
  return [...new Set(rows.map((r) => re.exec(String(r.source_doc_no ?? ''))?.[1]).filter(Boolean))].sort();
}

const fmt = (b) => `${b.mov} / ${b.lots}`;

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} repair=${REPAIR_DOC_NO} run=${REPAIR_RUN_ID}${ONLY_ITEM ? ` item=${ONLY_ITEM}` : ''}`);
  const whRows = await sql`SELECT id::text AS id, COALESCE(code, name) AS code FROM scm.warehouses WHERE company_id = ${CO}`;
  const whName = new Map(whRows.map((w) => [w.id, w.code]));
  const label = (p) => `${p.itemCode} @ ${whName.get(p.warehouseId) ?? p.warehouseId.slice(0, 8)}`;

  const { pairs, shapeProblems, repairRowCount } = await gather(sql, ONLY_ITEM);
  const outMonths = [];
  for (const p of pairs.values()) {
    say(`\n=== ${label(p)}: ${p.status.toUpperCase()} ===`);
    say('  bucket: movements / open lots    now -> after revert | before repair');
    for (const [vk, b] of p.now) {
      const a = p.after.get(vk) ?? { mov: 0, lots: 0 };
      const pre = p.pre.get(vk) ?? { mov: 0, lots: 0 };
      const same = a.mov === pre.mov && a.lots === pre.lots;
      say(`  ${show(vk)}: ${fmt(b)} -> ${fmt(a)} | ${fmt(pre)}${p.status === 'revert' ? (same ? '  (match)' : '  (DIFFERENT)') : ''}`);
    }
    for (const g of p.plans) {
      if (g.status === 'already-reverted') { say(`  [${g.specVk}] already reverted`); continue; }
      say(`  [${g.specVk}] ${g.q} unit(s) back to the no-spec lots`);
      for (const o of g.outResets ?? []) {
        outMonths.push(o.month);
        say(`    DO OUT back to uncosted: ${o.docNo} x${o.qtyRemoved} (${o.month})${o.consumedAfter ? `, ${o.consumedAfter} unit(s) stay costed from other lots` : ''}`);
      }
    }
    for (const m of p.problems) bad(`  REFUSED ${label(p)}: ${m}`);
  }

  const all = [...pairs.values()];
  const doing = all.filter((p) => p.status === 'revert');
  const refused = all.filter((p) => p.status === 'refused');
  const groups = doing.flatMap((p) => p.plans.filter((g) => g.status === 'revert'));
  const resets = groups.flatMap((g) => g.outResets);
  const closed = await closedMonths(sql);
  const affected = affectedClosedMonths(outMonths, closed);
  note(`\n=== TOTALS company ${CO} ===`);
  note(`  repair rows found (${REPAIR_DOC_NO}): ${repairRowCount}`);
  note(`  items x warehouses: ${all.length}; to revert ${doing.length}; already reverted ${all.filter((p) => p.status === 'already-reverted').length}; refused ${refused.length}`);
  note(`  spec buckets reverted: ${groups.length}; units back to the no-spec lots: ${groups.reduce((s, g) => s + g.q, 0)}`);
  note(`  DO OUTs back to uncosted: ${resets.length} (units ${resets.reduce((s, o) => s + o.qtyRemoved, 0)}); DOs to restamp: ${new Set(resets.map((o) => o.doId)).size}`);
  note(`  closed stock months: ${closed.join(', ') || 'none'}`);
  note(`  closed months this revert changes: ${affected.join(', ') || 'none'}`);
  const missing = unallowedMonths(affected, allowed.months);
  if (missing.length) note(`  APPLY needs ALLOW_CLOSED_MONTHS=${affected.join(',')} (not yet allowed: ${missing.join(', ')})`);
  for (const m of shapeProblems) bad(`  REFUSED: ${m}`);

  if (refused.length || shapeProblems.length) {
    bad(`REFUSED: ${refused.length} item(s) x warehouse(s) and ${shapeProblems.length} row(s) do not allow an exact revert (listed above). Nothing ${APPLY ? 'written' : 'would be written'}.`);
    await sql.end({ timeout: 5 });
    if (APPLY) process.exitCode = 1;
    return;
  }
  if (!APPLY || doing.length === 0) {
    note(doing.length ? `\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${REVERT_CONFIRM_PHRASE}"${affected.length ? ` ALLOW_CLOSED_MONTHS=${affected.join(',')}` : ''}.` : '\nNothing to revert.');
    await sql.end({ timeout: 5 });
    return;
  }
  if (missing.length) {
    bad(`REFUSED: the revert changes closed stock month(s) ${missing.join(', ')}. Set ALLOW_CLOSED_MONTHS to name them.`);
    await sql.end({ timeout: 5 });
    process.exitCode = 1;
    return;
  }

  /* ---- write, one transaction per item and warehouse ---- */
  note('\n=== WRITING ===');
  const docNo = `${REVERT_DOC_PREFIX}-${today()}`;
  const cols = new Set((await sql`SELECT column_name FROM information_schema.columns
                                   WHERE table_schema = 'scm' AND table_name = 'inventory_movements'`).map((r) => r.column_name));
  const insertMovement = async (tx, row) => {
    const names = Object.keys(row).filter((k) => cols.has(k));
    const dateSql = cols.has('movement_date') ? ', movement_date' : '';
    const dateVal = cols.has('movement_date') ? `, (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date` : '';
    const [ins] = await tx.unsafe(`INSERT INTO scm.inventory_movements (${names.join(', ')}${dateSql})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}${dateVal}) RETURNING id::text AS id`, names.map((k) => row[k]));
    return ins.id;
  };
  const done = [];
  const doIds = new Set();
  for (const [k, p] of pairs) {
    if (p.status !== 'revert') continue;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM scm.inventory_lots WHERE company_id = ${CO} AND item_code = ${p.itemCode}
                  AND warehouse_id = ${p.warehouseId} FOR UPDATE`;
        const again = (await gather(tx, p.itemCode)).pairs.get(k);
        if (!again || again.status !== 'revert' || planSignature(again.plans) !== planSignature(p.plans)) throw new Error('changed since the plan');
        const [nm] = await tx`SELECT MAX(product_name) AS n FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ${p.itemCode}`;
        const base = { movement_type: 'ADJUSTMENT', warehouse_id: p.warehouseId, item_code: p.itemCode, product_name: nm?.n ?? null,
          source_doc_type: 'ADJUSTMENT', source_doc_no: docNo, reason_code: REVERT_REASON_CODE, company_id: CO };
        const lotNow = new Map();
        for (const g of again.plans.filter((x) => x.status === 'revert')) {
          const restores = [...g.mintedRestores, ...g.emptyRestores];
          const lotIds = restores.map((r) => r.lotId);
          /* 1 + 3. The reconcile's and the -q row's consumptions, gone. */
          const del = await tx`DELETE FROM scm.inventory_lot_consumptions
                                WHERE lot_id = ANY(${lotIds}::uuid[]) AND id::text = ANY(${g.deleteConsumptionIds}::text[]) RETURNING id`;
          if (del.length !== g.deleteConsumptionIds.length) throw new Error(`deleted ${del.length} consumption(s), planned ${g.deleteConsumptionIds.length}`);
          /* ... and each lot gets its units back. */
          for (const r of restores) {
            const expect = lotNow.get(r.lotId) ?? r.expectRemaining;
            const up = await tx`UPDATE scm.inventory_lots SET qty_remaining = qty_remaining + ${r.add}
                                 WHERE id = ${r.lotId}::uuid AND company_id = ${CO} AND qty_remaining = ${expect}
                                   AND qty_remaining + ${r.add} <= qty_received RETURNING qty_remaining::int AS q`;
            if (up.length !== 1) throw new Error(`lot ${r.lotId.slice(0, 8)} was not at ${expect}`);
            lotNow.set(r.lotId, up[0].q);
          }
          /* 2. Each DO OUT back to its prior cost. */
          for (const o of g.outResets) {
            const up = await tx`UPDATE scm.inventory_movements SET total_cost_sen = ${o.toTotalSen}, unit_cost_sen = ${o.toUnitSen}
                                 WHERE id = ${o.movementId}::uuid AND company_id = ${CO} AND movement_type = 'OUT'
                                   AND COALESCE(total_cost_sen, 0) = ${o.fromTotalSen} RETURNING id`;
            if (up.length !== 1) throw new Error(`DO OUT ${o.docNo} changed since the plan`);
          }
          /* 4. The -q row, re-costed from its remaining consumptions: none. */
          const rc = await tx`UPDATE scm.inventory_movements SET total_cost_sen = 0, unit_cost_sen = 0
                               WHERE id = ${g.fromRecost.movementId}::uuid AND company_id = ${CO}
                                 AND COALESCE(total_cost_sen, 0) = ${g.fromRecost.expectTotalSen} RETURNING id`;
          if (rc.length !== 1) throw new Error('the repair -q row changed since the plan');
          /* 5. Spec bucket -q: its open lots must be exactly the ones the repair opened. */
          const open = await tx`SELECT id::text AS id, qty_remaining::int AS q FROM scm.inventory_lots
                                 WHERE company_id = ${CO} AND item_code = ${p.itemCode} AND warehouse_id = ${p.warehouseId}
                                   AND variant_key = ${g.specVk} AND qty_remaining > 0 ORDER BY id`;
          const want = [...g.specMinus.consumes].sort((a, b) => (a.lotId < b.lotId ? -1 : 1)).map((c) => [c.lotId, c.qty]);
          if (JSON.stringify(open.map((l) => [l.id, l.q])) !== JSON.stringify(want)) throw new Error(`the spec bucket's open lots are not the repair's lots`);
          const minusId = await insertMovement(tx, { ...base, variant_key: g.specVk, qty: g.specMinus.qty, unit_cost_sen: 0,
            notes: revertNotes({ side: 'spec', qty: g.specMinus.qty, specVk: g.specVk, fromRowId: g.fromRowId, ref: docNo }) });
          const used = await tx`SELECT lot_id::text AS id, SUM(qty_consumed)::int AS q FROM scm.inventory_lot_consumptions
                                 WHERE movement_id = ${minusId}::uuid GROUP BY 1 ORDER BY 1`;
          if (JSON.stringify(used.map((u) => [u.id, u.q])) !== JSON.stringify(want)) throw new Error('the spec -q row consumed other lots than the repair opened');
          /* 6. No-spec +q at cost 0, its lot closed: the units are back in the original lots. */
          const plusId = await insertMovement(tx, { ...base, variant_key: '', qty: g.emptyPlus.qty, unit_cost_sen: 0,
            notes: revertNotes({ side: 'empty', qty: g.emptyPlus.qty, specVk: g.specVk, fromRowId: g.fromRowId, ref: docNo }) });
          const closedLot = await tx`UPDATE scm.inventory_lots SET qty_remaining = 0
                                      WHERE movement_id = ${plusId}::uuid AND company_id = ${CO} RETURNING id`;
          if (closedLot.length !== 1) throw new Error(`expected one lot opened by the no-spec +q row, found ${closedLot.length}`);
          await tx`UPDATE scm.inventory_movements SET total_cost_sen = 0, unit_cost_sen = 0 WHERE id = ${plusId}::uuid AND company_id = ${CO}`;
          for (const o of g.outResets) doIds.add(o.doId);
        }
        await tx`INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
                 VALUES ('GLOBAL', ${randomUUID()}, now(), ${`cutover no-spec revert ${p.itemCode}`})
                 ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
                   requested_at = EXCLUDED.requested_at, reason = EXCLUDED.reason`;
      });
      done.push(k);
      note(`  OK   ${label(p)}`);
    } catch (e) {
      bad(`  FAIL ${label(p)}: ${e.message} (rolled back, nothing written for it)`);
      process.exitCode = 1;
    }
  }
  note(`  committed: ${done.length} of ${doing.length} item(s) x warehouse(s)`);

  if (doIds.size) {
    note(`\n=== RESTAMPING ${doIds.size} DO(s) (restampDoActualCost + restampSiFromDo) ===`);
    const { restampDoActualCost } = await import('../src/scm/routes/delivery-orders-mfg.ts');
    const { restampSiFromDo } = await import('../src/scm/lib/recost.ts');
    const { pgrestShim } = await import('./lib/pgrest-shim.mjs');
    const sb = pgrestShim(sql, 'scm');
    let failed = 0;
    for (const doId of doIds) {
      try {
        await restampDoActualCost(sb, doId);
        await restampSiFromDo(sb, doId);
        if (sb.__gaps.length) throw new Error(`shim gap: ${sb.__gaps.join('; ')}`);
      } catch (e) { failed += 1; bad(`  restamp ${doId.slice(0, 8)}: ${e.message}`); }
    }
    note(`  restamped ${doIds.size - failed} of ${doIds.size}${failed ? ' — re-run restamp-do-actual-cost.mjs for the failed ones' : ''}`);
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
      const p = pairs.get(k);
      const fresh = (await gather(check, p.itemCode)).pairs.get(k);
      for (const [vk, pre] of p.pre) {
        const b = fresh?.now.get(vk) ?? { mov: 0, lots: 0 };
        ok(b.mov === pre.mov && b.lots === pre.lots, `${label(p)} ${show(vk)}: ${fmt(b)} (before the repair ${fmt(pre)})`);
      }
      ok(fresh?.status === 'already-reverted', `${label(p)}: a re-plan finds ${fresh?.plans.filter((g) => g.status === 'revert').length ?? '?'} bucket(s) to revert (${fresh?.status ?? 'missing'})`);
      const groupsDone = p.plans.filter((g) => g.status === 'revert');
      const finalEmpty = new Map();
      for (const g of groupsDone) for (const r of g.emptyRestores) finalEmpty.set(r.lotId, (finalEmpty.get(r.lotId) ?? r.expectRemaining) + r.add);
      const minted = groupsDone.flatMap((g) => g.mintedRestores.map((r) => r.lotId));
      const ids = [...finalEmpty.keys(), ...minted];
      const lotRows = await check`SELECT id::text AS id, qty_remaining::int AS q FROM scm.inventory_lots WHERE company_id = ${CO} AND id = ANY(${ids}::uuid[])`;
      const lotQ = new Map(lotRows.map((l) => [l.id, l.q]));
      const emptyWrong = [...finalEmpty].filter(([id, q]) => lotQ.get(id) !== q).length;
      ok(emptyWrong === 0, `${label(p)}: ${finalEmpty.size - emptyWrong} of ${finalEmpty.size} no-spec lot(s) at their pre-repair qty_remaining`);
      const mintedOpen = minted.filter((id) => lotQ.get(id) !== 0).length;
      ok(mintedOpen === 0, `${label(p)}: lots the repair opened still open: ${mintedOpen} of ${minted.length}`);
      for (const o of groupsDone.flatMap((g) => g.outResets)) {
        const [r] = await check`
          SELECT COALESCE(m.total_cost_sen, 0)::bigint AS t,
                 (SELECT COUNT(*) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id AND c.lot_id = ANY(${minted}::uuid[]))::int AS on_minted,
                 COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id), 0)::int AS consumed
            FROM scm.inventory_movements m WHERE m.id = ${o.movementId}::uuid AND m.company_id = ${CO}`;
        ok(r && Number(r.t) === o.toTotalSen && r.on_minted === 0 && r.consumed === o.consumedAfter,
          `${o.docNo}: back to its prior cost, ${r?.consumed ?? '?'} unit(s) consumed (planned ${o.consumedAfter}), none from the repair's lots`);
      }
    }
    note(`  ${wrong} check(s) failed`);
    if (wrong > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
