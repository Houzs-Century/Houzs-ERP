#!/usr/bin/env node
/* Cost the uncosted stock-out movements of ONE item in NAMED warehouses.

   THE GAP. scm.fn_reconcile_uncosted_out (0154; current body
   20261026T1600_scm_retrocost_no_zero_overwrite.sql) is what costs an OUT that
   shipped before stock arrived: when a later IN opens a lot, it consumes the
   lot for the short OUT — a consumption row, the lot's qty_remaining down, the
   OUT's total/unit cost up by what was consumed. It only accepts OUTs whose
   source is a non-cancelled, non-drop-ship DO. Any other uncosted OUT (a stock
   transfer out, a negative adjustment) is left short forever, and the lot that
   later arrives stays open: the warehouse shows qty 0 with value still on it.

   First case (owner, 2026-11-10, option A): company 1, DUNLOPILLO RELAX SLEEP
   LUXURY MATT (K). PG SERVICE has an uncosted OUT of 1 and a lot opened by
   transfer HC-ST-2611-008 — qty 0, value on the shelf. KL has one uncosted OUT
   the retro-cost dry-run called "NOT auto-repairable" and qty 0.

   WHAT THIS DOES. The function is NOT weakened. For exactly the bucket named
   here (COMPANY_ID + ITEM_CODE + VARIANT_KEY, per warehouse in WAREHOUSE_IDS)
   it performs the same three steps the function would, in the same order
   (oldest short first, oldest lot first), and nothing else:
     - INSERT inventory_lot_consumptions (carrying the OUT's own source_doc_*)
     - UPDATE inventory_lots.qty_remaining -= taken
     - UPDATE the OUT: total_cost_sen += consumed cost, unit_cost_sen = total / |qty|
   The standard reconcile books no journal itself: stock value reaches the GL
   through the month-end stock close, and a DO's line cost through
   restampDoActualCost. So for a DO-sourced OUT the plan names the follow-up
   (restamp-do-actual-cost.mjs with DOS=...); a non-DO OUT has no document lines
   to restamp.

   NO OPEN LOT (KL). When a short has no lot to draw on, nothing is fabricated.
   The plan says so and PROPOSES the reference basis that backfill-fifo-
   divergence.mjs MODE=basis-cost uses (pickCostBasis: newest same-SKU GRN landed
   unit cost in the company, else the latest PO line cost). It is used only when
   the warehouse is also named in ALLOW_BASIS_WAREHOUSE_IDS; then a lot at that
   cost is seeded (notes "repair:uncosted-out-named-basis: ...") and consumed at
   once, exactly like basis-cost mode.

   REFUSED, never guessed: a short whose DO is CANCELLED or drop-ship; a bucket
   whose after-state would not be qty 0 / value 0; a bucket with open-lot value
   and no short OUT. Each refusal is printed with its reason.

   SAFETY.
   MODE=plan (default) reads, prints every movement / document / qty / lot / cost
   that would change and the after-state, then REHEARSES the exact apply inside a
   transaction and ROLLS IT BACK (so a plan also proves the SQL fits the live
   schema). It prints one PLAN HASH per warehouse.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN" and PLAN_HASHES=<the
   hashes the plan printed>. Each warehouse is ONE transaction: it locks the
   bucket's movements and lots, recomputes the plan, and refuses unless the hash
   is one of PLAN_HASHES — any change since the plan (a new OUT, a lot consumed,
   a cost edited) writes nothing. It then re-checks the bucket in-transaction.
   After commit a FRESH connection verifies the values: qty 0 and value 0 for the
   bucket, each target fully consumed at the planned cost, and — by xmin — that
   the rows the transaction wrote are exactly the planned rows of this item in
   this warehouse, so no other item changed.

   Run ONLY through Actions -> "Run a backend script on production":
     script  repair-uncosted-out-named.mjs
     env     COMPANY_ID=1;ITEM_CODE=<code>;WAREHOUSE_IDS=<uuid>,<uuid>
             [;VARIANT_KEY=<key>][;ALLOW_BASIS_WAREHOUSE_IDS=<uuid>][;PLAN_HASHES=<h>,<h>]
   Money is masked in the public Actions log (lib/public-log-guard.mjs); the plan
   hash binds the figures all the same.

   RE-RUN: inert once applied. Every short is recomputed from its own consumption
   rows (|qty| minus consumed), so a second run finds nothing short, plans the
   bucket as "nothing to do", and writes nothing. A stale PLAN_HASHES writes nothing. */
import "./lib/public-log-guard.mjs";
import postgres from "postgres";
import { pickCostBasis } from "./lib/ledger-repair-core.mjs";
import {
  planBucketRepair, planFingerprint, parseNamedRepairEnv, xminOf, checkWrittenRows,
} from "./lib/uncosted-out-named-core.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const BASIS_MARKER = "repair:uncosted-out-named-basis";

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => `RM${(Number(sen ?? 0) / 100).toFixed(2)}`;
const iso = (t) => (t instanceof Date ? t.toISOString() : String(t ?? "-"));

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const cfg = parseNamedRepairEnv(process.env);
if (cfg.errors.length) {
  for (const e of cfg.errors) bad(e);
  process.exit(2);
}
if (APPLY && cfg.planHashes.size === 0) {
  bad("MODE=apply requires PLAN_HASHES=<the plan hash(es) a PLAN run printed>");
  process.exit(2);
}
const { companyId: CO, itemCode: ITEM, variantKey: VK } = cfg;

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/* ── Reads. `lock` = inside the apply transaction, FOR UPDATE. ─────────────── */
async function loadConsumers(db, wh, lock) {
  return db.unsafe(`
    SELECT m.id::text AS id, m.movement_type::text AS movement_type, m.qty, m.created_at,
           m.movement_date, m.source_doc_type, m.source_doc_id::text AS source_doc_id,
           m.source_doc_no, m.unit_cost_sen, m.total_cost_sen, m.batch_no, m.product_name,
           COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c
                      WHERE c.movement_id = m.id), 0)::int AS consumed,
           d.do_number, d.status::text AS do_status, COALESCE(d.is_dropship, FALSE) AS do_dropship,
           (m.source_doc_type = 'DO' AND m.batch_no IS NOT NULL AND EXISTS (
              SELECT 1 FROM scm.delivery_order_items di
               WHERE di.delivery_order_id = m.source_doc_id
                 AND di.committed_po_batch_no = m.batch_no
                 AND di.item_code = m.item_code
                 AND COALESCE(di.committed_variant_key, '') = COALESCE(m.variant_key, '')
                 AND di.committed_batch_strict = TRUE)) AS strict_batch
      FROM scm.inventory_movements m
      LEFT JOIN scm.delivery_orders d ON m.source_doc_type = 'DO' AND d.id = m.source_doc_id
     WHERE m.company_id = $1 AND m.warehouse_id::text = $2 AND m.item_code = $3
       AND COALESCE(m.variant_key, '') = $4
       AND (m.movement_type = 'OUT' OR (m.movement_type = 'ADJUSTMENT' AND m.qty < 0))
     ORDER BY m.created_at, m.id
     ${lock ? "FOR UPDATE OF m" : ""}`, [CO, wh, ITEM, VK]);
}

async function loadOpenLots(db, wh, lock) {
  return db.unsafe(`
    SELECT id::text AS id, qty_received, qty_remaining, unit_cost_sen, received_at,
           source_doc_type, source_doc_no, batch_no, movement_id::text AS movement_id
      FROM scm.inventory_lots
     WHERE company_id = $1 AND warehouse_id::text = $2 AND item_code = $3
       AND COALESCE(variant_key, '') = $4 AND qty_remaining > 0
     ORDER BY received_at, id
     ${lock ? "FOR UPDATE" : ""}`, [CO, wh, ITEM, VK]);
}

/* qty exactly as the inventory breakdown shows it (inventory_balances). */
async function bucketQty(db, wh) {
  const r = await db.unsafe(`
    SELECT COALESCE(SUM(qty), 0)::int AS qty FROM scm.inventory_balances
     WHERE company_id = $1 AND warehouse_id::text = $2 AND item_code = $3
       AND COALESCE(variant_key, '') = $4`, [CO, wh, ITEM, VK]);
  return Number(r[0]?.qty ?? 0);
}

async function loadBasis(db) {
  const grn = await db.unsafe(`
    SELECT unit_cost_sen, source_doc_no FROM scm.inventory_movements
     WHERE movement_type = 'IN' AND source_doc_type = 'GRN' AND company_id = $1
       AND item_code = $2 AND COALESCE(variant_key, '') = $3
     ORDER BY created_at DESC, id DESC LIMIT 20`, [CO, ITEM, VK]);
  const po = await db.unsafe(`
    SELECT COALESCE(NULLIF(poi.unit_cost_sen, 0), poi.unit_price_sen) AS cost_sen, po.po_number
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
     WHERE po.company_id = $1 AND poi.item_code = $2
     ORDER BY poi.created_at DESC, poi.id DESC LIMIT 20`, [CO, ITEM]);
  return pickCostBasis({
    grnCandidates: grn.map((g) => ({ unitCostSen: Number(g.unit_cost_sen ?? 0), docNo: g.source_doc_no })),
    poCandidates: po.map((p) => ({ unitCostSen: Number(p.cost_sen ?? 0), docNo: p.po_number })),
  });
}

async function computePlan(db, wh, basis, lock) {
  const consumers = await loadConsumers(db, wh, lock);
  const openLots = await loadOpenLots(db, wh, lock);
  const onHandQty = await bucketQty(db, wh);
  const plan = planBucketRepair({ consumers, openLots, onHandQty, basis, allowBasis: cfg.allowBasis.has(wh) });
  const hash = planFingerprint({ companyId: CO, warehouseId: wh, itemCode: ITEM, variantKey: VK, plan, basis });
  return { consumers, openLots, onHandQty, plan, hash };
}

/* ── Context the owner needs to judge a target (read-only, plan output). ──── */
async function printContext(wh, consumers, openLots, plan) {
  note(`  consuming movements in this bucket: ${consumers.length}`);
  for (const m of consumers) {
    const out = Math.abs(Number(m.qty)) - Number(m.consumed);
    note(`    ${m.id}  ${m.movement_type} qty=${m.qty} consumed=${m.consumed} outstanding=${out}  ${m.source_doc_type ?? "-"} ${m.do_number ?? m.source_doc_no ?? "-"}${m.do_status ? ` [DO ${m.do_status}${m.do_dropship ? ", drop-ship" : ""}]` : ""}  created ${iso(m.created_at)}  total_cost_sen=${m.total_cost_sen ?? 0}`);
  }
  note(`  open lots: ${openLots.length}`);
  for (const l of openLots) {
    note(`    lot ${l.id}  remaining=${l.qty_remaining}/${l.qty_received}  unit_cost_sen=${l.unit_cost_sen}  from ${l.source_doc_type ?? "-"} ${l.source_doc_no ?? "-"}  received ${iso(l.received_at)}`);
  }
  /* The sibling rows of each short's document — for a transfer OUT, the IN at
     the other warehouse and the lot it opened. Shown, never changed. */
  const shortIds = new Set([...plan.targets.map((t) => t.movementId), ...plan.refused.map((r) => r.id)]);
  for (const m of consumers.filter((x) => shortIds.has(x.id) && x.source_doc_id)) {
    const sib = await sql.unsafe(`
      SELECT s.id::text AS id, s.movement_type::text AS movement_type, s.qty, s.warehouse_id::text AS warehouse_id,
             w.name AS warehouse_name, s.item_code, s.unit_cost_sen, s.total_cost_sen,
             l.id::text AS lot_id, l.qty_remaining AS lot_remaining, l.unit_cost_sen AS lot_unit_cost_sen
        FROM scm.inventory_movements s
        LEFT JOIN scm.warehouses w ON w.id = s.warehouse_id
        LEFT JOIN scm.inventory_lots l ON l.movement_id = s.id
       WHERE s.source_doc_type = $1 AND s.source_doc_id::text = $2 AND s.id::text <> $3 AND s.company_id = $4
       ORDER BY s.created_at, s.id`, [m.source_doc_type, m.source_doc_id, m.id, CO]);
    note(`  document ${m.source_doc_type} ${m.do_number ?? m.source_doc_no ?? m.source_doc_id}: ${sib.length} sibling movement(s)`);
    for (const s of sib) {
      note(`    ${s.id}  ${s.movement_type} qty=${s.qty} ${s.item_code} at ${s.warehouse_name ?? s.warehouse_id}  unit_cost_sen=${s.unit_cost_sen ?? 0}${s.lot_id ? `  opened lot ${s.lot_id} remaining=${s.lot_remaining} lot_unit_cost_sen=${s.lot_unit_cost_sen}` : ""}`);
      if (s.lot_id && Number(s.lot_unit_cost_sen ?? 0) === 0) {
        note(`      NOTE: that lot carries no cost. This repair does not change it; it is listed so the owner sees it.`);
      }
    }
  }
  /* A month whose stock value was already closed to the GL. */
  const months = [...new Set(plan.targets.map((t) => consumers.find((c) => c.id === t.movementId))
    .map((c) => iso(c?.movement_date ?? c?.created_at).slice(0, 7)))];
  if (months.length) {
    try {
      const runs = await sql`
        SELECT month, action, ran_at FROM scm.acc_stock_close_runs
         WHERE company_id = ${CO} AND month = ANY(${months}) AND action IN ('posted', 'reposted', 'unchanged')
         ORDER BY ran_at DESC`;
      for (const mo of months) {
        const r = runs.find((x) => x.month === mo);
        note(`  stock close for ${mo}: ${r ? `${r.action} at ${iso(r.ran_at)} — that month's GL stock value was posted before this repair; the next close/re-post of ${mo} reflects it` : "not closed yet"}`);
      }
    } catch (e) {
      note(`  stock close status unavailable (${e.message})`);
    }
  }
}

function printPlan(name, wh, plan, hash, basis) {
  note(`  BEFORE  qty=${plan.before.qty}  value=${rm(plan.before.valueSen)}`);
  for (const t of plan.targets) {
    note(`  TARGET  movement ${t.movementId}  ${t.movementType} ${t.docType ?? "-"} ${t.doc ?? "-"}  qty=${t.qty} outstanding=${t.outstanding}`);
    for (const x of t.takes) {
      const from = x.lotId === "BASIS"
        ? `a SEEDED reference-cost lot (basis ${basis?.source} ${basis?.docNo}, newest same-SKU ${basis?.source === "GRN" ? "GRN landed cost" : "PO line cost"})`
        : `lot ${x.lotId}`;
      note(`          consume ${x.qty} from ${from} @ ${rm(x.unitCostSen)} = ${rm(x.costSen)}`);
    }
    if (t.residual > 0) note(`          ${t.residual} unit(s) left uncosted (no lot)`);
    note(`          OUT cost ${rm(t.oldTotalSen)} -> ${rm(t.newTotalSen)} (unit ${rm(t.newUnitSen)})`);
  }
  for (const r of plan.refused) note(`  REFUSED movement ${r.id} (${r.doc ?? "no doc"}) outstanding=${r.outstanding} — ${r.why}`);
  for (const l of plan.lotsAfter) if (l.before !== l.after) note(`  LOT     ${l.id}  remaining ${l.before} -> ${l.after}`);
  if (plan.basisUnits > 0) note(`  BASIS   ${plan.basisUnits} unit(s) at ${rm(basis.unitCostSen)} from ${basis.source} ${basis.docNo} — a REFERENCE cost, not a receipt (${BASIS_MARKER})`);
  note(`  AFTER   qty=${plan.after.qty}  value=${rm(plan.after.valueSen)}  (cost added to OUTs: ${rm(plan.addedSen)})`);
  for (const r of plan.reasons) note(`  NOTE    ${r}`);
  note(`  VERDICT ${plan.status.toUpperCase()}   plan_hash=${hash}`);
}

/* ── The write: one warehouse, one transaction. ───────────────────────────── */
async function writeWarehouse(wh, basis, expectedHashes) {
  return sql.begin(async (tx) => {
    const fresh = await computePlan(tx, wh, basis, true);
    if (fresh.plan.status !== "repair") throw { refuse: `status is ${fresh.plan.status}, not REPAIR: ${fresh.plan.reasons.join("; ")}` };
    if (!expectedHashes.has(fresh.hash)) throw { refuse: `plan hash is now ${fresh.hash}, which is not in PLAN_HASHES — the bucket changed since the plan (or this warehouse's hash was not supplied). Re-run PLAN.` };
    const [{ xid }] = await tx`SELECT pg_current_xact_id()::text AS xid`;

    const written = { lot: new Set(), consumption: new Set(), movement: new Set() };
    let seededLotId = null;
    for (const t of fresh.plan.targets) {
      for (const x of t.takes) {
        let lotId = x.lotId;
        if (lotId === "BASIS") {
          if (!seededLotId) {
            const src = fresh.consumers.find((c) => c.id === t.movementId);
            const seeded = await tx.unsafe(`
              INSERT INTO scm.inventory_lots (
                warehouse_id, item_code, product_name, variant_key,
                qty_received, qty_remaining, unit_cost_sen, received_at,
                source_doc_type, source_doc_id, source_doc_no, movement_id,
                created_by, batch_no, company_id, notes
              ) VALUES ($1::uuid, $2, $3, $4, $5, $5, $6, now(), NULL, NULL, NULL, NULL, NULL, NULL, $7, $8)
              RETURNING id::text AS id`,
              [wh, ITEM, src?.product_name ?? ITEM, VK, fresh.plan.basisUnits, Number(basis.unitCostSen), CO,
                `${BASIS_MARKER}: reference-cost lot for ${fresh.plan.targets.map((y) => `${y.movementId} (${y.docType ?? "-"} ${y.doc ?? "-"})`).join(" + ")} (basis ${basis.source} ${basis.docNo} @ ${basis.unitCostSen} sen/unit); consumed immediately`]);
            seededLotId = seeded[0].id;
          }
          lotId = seededLotId;
        }
        const dec = await tx.unsafe(`
          UPDATE scm.inventory_lots SET qty_remaining = qty_remaining - $2
           WHERE id::text = $1 AND company_id = $3 AND warehouse_id::text = $4 AND item_code = $5
             AND COALESCE(variant_key, '') = $6 AND qty_remaining >= $2 AND unit_cost_sen = $7
          RETURNING id::text AS id`, [lotId, x.qty, CO, wh, ITEM, VK, x.unitCostSen]);
        if (dec.length !== 1) throw { refuse: `lot ${lotId} could not give ${x.qty} unit(s) at the planned cost` };
        written.lot.add(lotId);
        const cons = await tx.unsafe(`
          INSERT INTO scm.inventory_lot_consumptions (
            lot_id, warehouse_id, item_code, variant_key,
            qty_consumed, unit_cost_sen, total_cost_sen,
            source_doc_type, source_doc_id, source_doc_no, movement_id, created_by, company_id
          )
          SELECT l.id, l.warehouse_id, l.item_code, COALESCE(m.variant_key, ''),
                 $3::int, l.unit_cost_sen, $3::int * l.unit_cost_sen,
                 m.source_doc_type, m.source_doc_id, m.source_doc_no, m.id, NULL, l.company_id
            FROM scm.inventory_lots l
            JOIN scm.inventory_movements m ON m.id::text = $2
           WHERE l.id::text = $1
          RETURNING id::text AS id`, [lotId, t.movementId, x.qty]);
        if (cons.length !== 1) throw { refuse: `consumption for movement ${t.movementId} on lot ${lotId} was not inserted` };
        written.consumption.add(cons[0].id);
      }
      const upd = await tx.unsafe(`
        UPDATE scm.inventory_movements
           SET total_cost_sen = COALESCE(total_cost_sen, 0) + $2::bigint,
               unit_cost_sen  = CASE WHEN ABS(qty) > 0
                                     THEN (COALESCE(total_cost_sen, 0) + $2::bigint) / ABS(qty) ELSE 0 END
         WHERE id::text = $1 AND company_id = $3 AND warehouse_id::text = $4 AND item_code = $5
        RETURNING id::text AS id, total_cost_sen, unit_cost_sen`, [t.movementId, t.addedSen, CO, wh, ITEM]);
      if (upd.length !== 1) throw { refuse: `movement ${t.movementId} was not updated` };
      if (Number(upd[0].total_cost_sen) !== t.newTotalSen || Number(upd[0].unit_cost_sen) !== t.newUnitSen) {
        throw { refuse: `movement ${t.movementId} now reads total ${upd[0].total_cost_sen} / unit ${upd[0].unit_cost_sen}, plan said ${t.newTotalSen} / ${t.newUnitSen}` };
      }
      written.movement.add(t.movementId);
    }

    // In-transaction re-check: the bucket now is what the plan said.
    const after = await computePlan(tx, wh, basis, false);
    const problems = [];
    if (after.onHandQty !== fresh.plan.after.qty) problems.push(`qty is ${after.onHandQty}, plan said ${fresh.plan.after.qty}`);
    if (after.plan.before.valueSen !== fresh.plan.after.valueSen) problems.push(`open-lot value differs from the plan's after-state`);
    for (const t of fresh.plan.targets) {
      const m = after.consumers.find((c) => c.id === t.movementId);
      if (!m || Math.abs(Number(m.qty)) - Number(m.consumed) !== 0) problems.push(`movement ${t.movementId} is still short`);
    }
    if (problems.length) throw { refuse: `in-transaction re-check failed: ${problems.join("; ")}` };

    const result = { xid, hash: fresh.hash, plan: fresh.plan, seededLotId, written: Object.fromEntries(Object.entries(written).map(([k, v]) => [k, [...v]])) };
    if (!APPLY) throw { rehearsed: result };
    return result;
  });
}

async function main() {
  note(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing; the apply is rehearsed and rolled back)"} company=${CO} item="${ITEM}" variant_key="${VK}"`);
  const whRows = await sql`SELECT id::text AS id, code, name FROM scm.warehouses WHERE id::text = ANY(${cfg.warehouseIds})`;
  const whName = new Map(whRows.map((w) => [w.id.toLowerCase(), `${w.name ?? w.code} (${w.id})`]));
  for (const wh of cfg.warehouseIds) if (!whName.has(wh)) { bad(`warehouse ${wh} does not exist`); await sql.end({ timeout: 5 }); process.exit(2); }

  const basis = await loadBasis(sql);
  note(`reference basis for this item (used only for warehouses in ALLOW_BASIS_WAREHOUSE_IDS): ${basis.source ? `${basis.source} ${basis.docNo} @ ${rm(basis.unitCostSen)}` : "none — no GRN/PO with a nonzero cost"}`);

  const results = [];
  for (const wh of cfg.warehouseIds) {
    note(`\n=== ${whName.get(wh)} ===`);
    const p = await computePlan(sql, wh, basis, false);
    if (p.consumers.length === 0 && p.openLots.length === 0) {
      const near = await sql.unsafe(`
        SELECT DISTINCT item_code FROM scm.inventory_movements
         WHERE company_id = $1 AND warehouse_id::text = $2 AND upper(item_code) LIKE upper(left($3, 18)) || '%' LIMIT 10`, [CO, wh, ITEM]);
      note(`  no OUT and no open lot for this exact item code here.${near.length ? ` Similar codes in this warehouse: ${near.map((r) => `"${r.item_code}"`).join(", ")}` : ""}`);
    }
    await printContext(wh, p.consumers, p.openLots, p.plan);
    printPlan(whName.get(wh), wh, p.plan, p.hash, basis);
    results.push({ wh, ...p });
  }

  const repairable = results.filter((r) => r.plan.status === "repair");
  note(`\n=== ${APPLY ? "APPLY" : "REHEARSAL (rolled back)"} ===`);
  const committed = [];
  for (const r of repairable) {
    try {
      const out = await writeWarehouse(r.wh, basis, APPLY ? cfg.planHashes : new Set([r.hash]));
      committed.push({ wh: r.wh, ...out });
      note(`  ${whName.get(r.wh)}: COMMITTED (plan_hash=${out.hash})`);
    } catch (e) {
      if (e && e.rehearsed) note(`  ${whName.get(r.wh)}: rehearsal OK — every write applied and re-checked, then rolled back (plan_hash=${e.rehearsed.hash})`);
      else if (e && e.refuse) bad(`  ${whName.get(r.wh)}: REFUSED, nothing written — ${e.refuse}`);
      else bad(`  ${whName.get(r.wh)}: FAILED, rolled back — ${e?.message ?? e}`);
    }
  }
  for (const r of results.filter((x) => x.plan.status !== "repair")) note(`  ${whName.get(r.wh)}: not written (${r.plan.status})`);

  const doFollowUps = [...new Set(results.flatMap((r) => r.plan.targets).filter((t) => String(t.docType).toUpperCase() === "DO" && t.doc).map((t) => t.doc))];
  if (!APPLY) {
    const hashes = repairable.map((r) => r.hash);
    note(`\nPLAN ONLY: nothing written.${hashes.length ? ` To apply: MODE=apply, CONFIRM="${CONFIRM_PHRASE}", and add ;PLAN_HASHES=${hashes.join(",")} to the env.` : " Nothing is repairable as configured."}`);
    if (doFollowUps.length) note(`After APPLY, restamp the DO lines the standard reconcile would: script restamp-do-actual-cost.mjs, env DOS=${doFollowUps.join(",")}`);
    await sql.end({ timeout: 5 });
    return;
  }

  await sql.end({ timeout: 5 });
  const failed = await verifyFresh(committed);
  if (doFollowUps.length) note(`\nNEXT: restamp the DO lines the standard reconcile would: script restamp-do-actual-cost.mjs, env DOS=${doFollowUps.join(",")}`);
  if (failed || committed.length !== cfg.warehouseIds.length) process.exitCode = 1;
}

/* ── After commit: a FRESH connection reads the values back. ──────────────── */
async function verifyFresh(committed) {
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let failed = false;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    for (const c of committed) {
      const problems = [];
      const [bal] = await check.unsafe(`
        SELECT COALESCE(SUM(qty), 0)::int AS qty FROM scm.inventory_balances
         WHERE company_id = $1 AND warehouse_id::text = $2 AND item_code = $3 AND COALESCE(variant_key, '') = $4`, [CO, c.wh, ITEM, VK]);
      const lots = await check.unsafe(`
        SELECT id::text AS id, qty_remaining, unit_cost_sen FROM scm.inventory_lots
         WHERE company_id = $1 AND warehouse_id::text = $2 AND item_code = $3 AND COALESCE(variant_key, '') = $4 AND qty_remaining <> 0`, [CO, c.wh, ITEM, VK]);
      if (Number(bal.qty) !== 0) problems.push(`qty reads ${bal.qty}, expected 0`);
      if (lots.length) problems.push(`open lots remain: ${lots.map((l) => `${l.id} remaining=${l.qty_remaining}`).join(", ")} — value is not 0`);
      for (const t of c.plan.targets) {
        const [m] = await check.unsafe(`
          SELECT m.qty, m.total_cost_sen, m.unit_cost_sen,
                 COALESCE((SELECT SUM(qty_consumed) FROM scm.inventory_lot_consumptions WHERE movement_id = m.id), 0)::int AS consumed
            FROM scm.inventory_movements m WHERE m.id::text = $1`, [t.movementId]);
        if (!m) { problems.push(`movement ${t.movementId} is gone`); continue; }
        if (Math.abs(Number(m.qty)) !== Number(m.consumed)) problems.push(`movement ${t.movementId} consumed ${m.consumed} of ${Math.abs(Number(m.qty))}`);
        if (Number(m.total_cost_sen) !== t.newTotalSen) problems.push(`movement ${t.movementId} cost is not the planned cost`);
      }
      // Every row this transaction wrote, found by its xid: exactly the planned
      // rows, all of this item, this warehouse, this company. Nothing else moved.
      const x = xminOf(c.xid);
      const written = await check.unsafe(`
        SELECT 'lot' AS t, id::text AS id, item_code, warehouse_id::text AS warehouse_id, company_id
          FROM scm.inventory_lots WHERE xmin::text = $1
        UNION ALL
        SELECT 'consumption', id::text, item_code, warehouse_id::text, company_id
          FROM scm.inventory_lot_consumptions WHERE xmin::text = $1
        UNION ALL
        SELECT 'movement', id::text, item_code, warehouse_id::text, company_id
          FROM scm.inventory_movements WHERE xmin::text = $1`, [x]);
      problems.push(...checkWrittenRows({ written, expected: c.written, companyId: CO, warehouseId: c.wh, itemCode: ITEM }));
      if (problems.length) {
        failed = true;
        for (const p of problems) bad(`  ${c.wh}: ${p}`);
      } else {
        note(`  ${c.wh}: PASS — qty 0, no open lot (value 0), ${c.plan.targets.length} OUT(s) fully consumed at the planned cost; the transaction wrote exactly ${written.length} row(s), all "${ITEM}" in this warehouse${c.seededLotId ? `; seeded basis lot ${c.seededLotId} fully consumed` : ""}`);
      }
    }
  } finally {
    await check.end({ timeout: 5 });
  }
  return failed;
}

main().catch(async (e) => {
  bad(e?.message ?? String(e));
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
