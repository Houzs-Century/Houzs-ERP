// Read-only: for company-1 hard-bound DO lines, did the lot that costed the line
// come from the line's bound purchase order?
//
// WHY. Company 1 binds a bedframe / sofa / fabric accessory / dining / (SP)
// mattress sales line to the PO raised for it (isHardBoundLine,
// src/scm/lib/so-stock-allocation.ts), and readiness lights such a line only
// through that PO's received_qty. COGS does not follow the binding: a non-sofa DO
// OUT carries no batch_no (deductInventoryForDo, delivery-orders-mfg.ts), so the
// FIFO trigger and fn_reconcile_uncosted_out cost it from the oldest open lot of
// the same warehouse + item + variant_key, whatever PO that lot came from. The
// cutover no-spec repair of 2026-11-10 (run 42827135058) costed 37 DO OUTs that
// way from AutoCount cutover layers. This check shows, per line, which PO the
// costing lot belongs to and whether that is the bound PO.
//
// SECTIONS
//   A. Lines costed by the repair: DO OUTs that consumed a lot opened by an
//      ADJUSTMENT whose source_doc_no starts with REF (default CUTOVER-NOSPEC-),
//      plus every OUT of the DOs named in DO_NOS. Per line: DO, item, warehouse,
//      bound PO(s) and GRN(s), the costing lot's source (for a repair lot, the
//      cutover layer it was moved from), the PO that lot belongs to, the verdict
//      and the ratio actual / expected unit cost. Never an amount.
//   B. CENSUS=1: the same verdict over every company-1 DO OUT since CUTOVER,
//      counts only — how often FIFO already costs a hard-bound line from its
//      own PO.
//   C. Negative buckets after CUTOVER split by hard-bound vs pooled item, with the
//      uncosted OUT units in each: which negatives can change readiness at all.
//
// Expected unit cost = the bound PO's own GRN lots (recost.ts keeps them at the
// PI price), else the cutover layers relayered from the bound PO's AutoCount
// receipt (grns.linked_ac_docno), else the MYR PO line price.
//
// PUBLIC LOG: document numbers, item codes, warehouse codes, quantities, verdicts
// and percentages only. No cost, amount, customer or phone.
//
//   Actions -> "Run a backend script on production": script
//   check-hard-bound-cost-vs-lot.mjs, mode plan, env e.g.
//   COMPANY_ID=1;REF=CUTOVER-NOSPEC-2026-11-10;CENSUS=1;DO_NOS=HC-DO-2609-204,HC-DO-2610-001
//
// SELECTs only, in one READ ONLY transaction; every query names company_id.
// Exits 0 for every real answer. Only a missing DATABASE_URL, an unreachable
// database or a query error exits non-zero.
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

import { computeVariantKey } from '../src/scm/shared/variant-key.ts';
import { isHardBoundLine } from '../src/scm/lib/so-stock-allocation.ts';
import {
  DEFAULT_REF_PREFIX, VERDICTS, parseAcDoc, originCandidates, lotPos, classifyLine, expectedUnitCost,
  costRatio, sameCost, tally, parseDocNos,
} from './lib/hard-bound-cost-check.mjs';
import { DEFAULT_CUTOVER, isNegativeAfterCutover, intEnv } from './lib/variant-key-drift.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.'); process.exit(1); }

const CO = Number.parseInt(process.env.COMPANY_ID || '1', 10);
const REF = /^[A-Z0-9-]+$/.test(process.env.REF ?? '') ? process.env.REF : DEFAULT_REF_PREFIX;
const DO_NOS = parseDocNos(process.env.DO_NOS);
const CENSUS = process.env.CENSUS === '1';
const CUTOVER = /^\d{4}-\d{2}-\d{2}$/.test(process.env.CUTOVER ?? '') ? process.env.CUTOVER : DEFAULT_CUTOVER;
const LIMIT = intEnv(process.env.LIMIT, 40, 500);
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CHUNK = 2000;
const chunks = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; };
const keyOf = (g, v) => computeVariantKey(g, v && typeof v === 'object' ? v : {});

async function many(ids, fn) {
  const out = [];
  for (const c of chunks(ids)) out.push(...await fn(c));
  return out;
}

/* Every DO OUT in `movementIds`, resolved to one result row per OUT. */
async function analyse(sql, movementIds) {
  if (movementIds.length === 0) return [];
  const outs = await many(movementIds, (c) => sql`
    SELECT m.id::text AS id, m.source_doc_id::text AS "doId", d.do_number AS "doNo", m.item_code AS "itemCode",
           COALESCE(m.variant_key, '') AS vk, COALESCE(w.code, w.name) AS wh, ABS(m.qty)::int AS qty
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id AND d.company_id = ${CO}
      LEFT JOIN scm.warehouses w ON w.id = m.warehouse_id AND w.company_id = ${CO}
     WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND m.id::text = ANY(${c})`);

  const cons = await many(outs.map((o) => o.id), (c) => sql`
    SELECT c.movement_id::text AS "movementId", c.qty_consumed::int AS qty,
           COALESCE(c.total_cost_sen, c.qty_consumed * c.unit_cost_sen, 0)::bigint AS "totalSen",
           l.id::text AS "lotId", l.source_doc_type AS "sourceDocType", l.source_doc_no AS "sourceDocNo",
           l.source_doc_id::text AS "sourceDocId", l.batch_no AS "batchNo", l.warehouse_id::text AS "warehouseId",
           l.item_code AS "itemCode", l.qty_received::int AS "qtyReceived", COALESCE(l.unit_cost_sen, 0)::bigint AS "unitCostSen",
           (EXTRACT(EPOCH FROM l.received_at) * 1000000)::bigint::text AS "receivedUs", lm.notes AS "movementNotes"
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_lots l ON l.id = c.lot_id AND l.company_id = ${CO}
      LEFT JOIN scm.inventory_movements lm ON lm.id = l.movement_id AND lm.company_id = ${CO}
     WHERE c.movement_id::text = ANY(${c})`);

  /* Repair lots -> the cutover layer each was moved from. */
  const minted = cons.filter((c) => String(c.sourceDocType).toUpperCase() === 'ADJUSTMENT' && String(c.sourceDocNo ?? '').startsWith(DEFAULT_REF_PREFIX));
  const refDocs = [...new Set(minted.map((m) => m.sourceDocNo))];
  const fromSide = refDocs.length === 0 ? [] : await sql`
    SELECT m2.source_doc_no AS "refDocNo", c2.qty_consumed::int AS "qtyConsumed",
           l2.id::text AS "lotId", l2.source_doc_type AS "sourceDocType", l2.source_doc_no AS "sourceDocNo",
           l2.source_doc_id::text AS "sourceDocId", l2.batch_no AS "batchNo", l2.warehouse_id::text AS "warehouseId",
           l2.item_code AS "itemCode", COALESCE(l2.unit_cost_sen, 0)::bigint AS "unitCostSen",
           (EXTRACT(EPOCH FROM l2.received_at) * 1000000)::bigint::text AS "receivedUs", lm2.notes AS "movementNotes"
      FROM scm.inventory_movements m2
      JOIN scm.inventory_lot_consumptions c2 ON c2.movement_id = m2.id
      JOIN scm.inventory_lots l2 ON l2.id = c2.lot_id AND l2.company_id = ${CO}
      LEFT JOIN scm.inventory_movements lm2 ON lm2.id = l2.movement_id AND lm2.company_id = ${CO}
     WHERE m2.company_id = ${CO} AND m2.movement_type = 'ADJUSTMENT' AND m2.qty < 0
       AND m2.source_doc_no = ANY(${refDocs}) AND COALESCE(m2.variant_key, '') = ''`;
  const originOf = new Map();
  for (const m of minted) {
    if (originOf.has(m.lotId)) continue;
    originOf.set(m.lotId, originCandidates({ ...m, refDocNo: m.sourceDocNo }, fromSide));
  }

  /* PO lookups for every lot that may cost a line. */
  const allLots = [...cons, ...[...originOf.values()].flat()];
  const grnIds = [...new Set(allLots.filter((l) => String(l.sourceDocType).toUpperCase() === 'GRN' && l.sourceDocId).map((l) => l.sourceDocId))];
  const acDocs = [...new Set(allLots.map((l) => parseAcDoc(l.movementNotes)?.doc).filter(Boolean))];
  const poByGrnId = new Map((await many(grnIds, (c) => sql`
    SELECT g.id::text AS id, po.po_number AS "poNo" FROM scm.grns g JOIN scm.purchase_orders po ON po.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND g.id::text = ANY(${c})`)).map((r) => [r.id, r.poNo]));
  const poByAcDoc = new Map();
  for (const r of await many(acDocs, (c) => sql`
    SELECT g.linked_ac_docno AS doc, po.po_number AS "poNo" FROM scm.grns g JOIN scm.purchase_orders po ON po.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND g.linked_ac_docno = ANY(${c})`)) {
    poByAcDoc.set(r.doc, [...new Set([...(poByAcDoc.get(r.doc) ?? []), r.poNo])]);
  }

  /* DO line -> SO line -> bound PO lines -> their GRNs. */
  const doIds = [...new Set(outs.map((o) => o.doId))];
  const doLines = await many(doIds, (c) => sql`
    SELECT i.delivery_order_id::text AS "doId", i.item_code AS "itemCode", i.item_group AS "itemGroup", i.variants,
           i.so_item_id::text AS "soItemId"
      FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
     WHERE d.company_id = ${CO} AND i.delivery_order_id::text = ANY(${c})`);
  const soItemIds = [...new Set(doLines.map((l) => l.soItemId).filter(Boolean))];
  const poLines = await many(soItemIds, (c) => sql`
    SELECT DISTINCT pi.id::text AS id, po.po_number AS "poNo", UPPER(COALESCE(po.status::text, '')) AS status,
           UPPER(COALESCE(po.currency::text, 'MYR')) AS currency, pi.item_code AS "itemCode",
           COALESCE(pi.received_qty, 0)::int AS received, COALESCE(pi.unit_price_sen, 0)::bigint AS "unitPriceSen",
           COALESCE(pi.so_item_id, a.so_item_id)::text AS "soItemId"
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${CO}
      LEFT JOIN scm.purchase_order_item_allocations a
             ON a.purchase_order_item_id = pi.id AND a.company_id = ${CO} AND a.so_item_id::text = ANY(${c})
     WHERE pi.so_item_id::text = ANY(${c}) OR a.so_item_id IS NOT NULL`);
  const live = poLines.filter((p) => p.received > 0 && !['CANCELLED', 'DRAFT'].includes(p.status));
  const grnLines = await many([...new Set(live.map((p) => p.id))], (c) => sql`
    SELECT gi.purchase_order_item_id::text AS "poItemId", g.id::text AS "grnId", g.grn_number AS "grnNo",
           g.linked_ac_docno AS "acDoc", g.migrated_no_stock AS migrated
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE g.company_id = ${CO} AND gi.purchase_order_item_id::text = ANY(${c})`);
  const boundGrnIds = [...new Set(grnLines.map((g) => g.grnId))];
  const boundAcDocs = [...new Set(grnLines.map((g) => g.acDoc).filter(Boolean))];
  const grnLots = await many(boundGrnIds, (c) => sql`
    SELECT source_doc_id::text AS "grnId", item_code AS "itemCode", qty_received::int AS qty, COALESCE(unit_cost_sen, 0)::bigint AS "unitCostSen"
      FROM scm.inventory_lots WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id::text = ANY(${c})`);
  const layers = await many(boundAcDocs, (c) => sql`
    SELECT split_part(m.notes, ' ', 3) AS doc, l.item_code AS "itemCode", l.qty_received::int AS qty, COALESCE(l.unit_cost_sen, 0)::bigint AS "unitCostSen"
      FROM scm.inventory_lots l JOIN scm.inventory_movements m ON m.id = l.movement_id AND m.company_id = ${CO}
     WHERE l.company_id = ${CO} AND l.source_doc_type = 'AC_CUTOVER' AND m.notes LIKE 'AC %' AND split_part(m.notes, ' ', 3) = ANY(${c})`);

  return outs.map((o) => {
    const sameItem = doLines.filter((l) => l.doId === o.doId && l.itemCode === o.itemCode);
    const exact = sameItem.filter((l) => keyOf(l.itemGroup, l.variants) === o.vk);
    const lines = exact.length ? exact : sameItem;
    const hardBound = lines.some((l) => isHardBoundLine(l.itemGroup, l.itemCode));
    const group = lines[0]?.itemGroup ?? '-';
    const soIds = new Set(lines.map((l) => l.soItemId).filter(Boolean));
    const bound = live.filter((p) => soIds.has(p.soItemId) && p.itemCode === o.itemCode);
    const boundPoNos = [...new Set(bound.map((p) => p.poNo))].sort();
    const bGrn = grnLines.filter((g) => bound.some((p) => p.id === g.poItemId));
    const costing = cons.filter((c) => c.movementId === o.id).map((c) => {
      const origins = originOf.get(c.lotId);
      const zero = Number(c.unitCostSen) === 0;
      if (!origins) return { qty: c.qty, totalSen: Number(c.totalSen), zero, pos: lotPos(c, poByGrnId, poByAcDoc), src: `${c.sourceDocType ?? '-'} ${c.sourceDocNo ?? '-'}` };
      const posSets = origins.map((x) => lotPos(x, poByGrnId, poByAcDoc).join('+'));
      const ambiguous = new Set(posSets).size > 1;
      const first = origins[0];
      const ac = first ? parseAcDoc(first.movementNotes) : null;
      return {
        qty: c.qty, totalSen: Number(c.totalSen), zero,
        pos: !first || ambiguous ? [] : lotPos(first, poByGrnId, poByAcDoc),
        src: !first ? `${c.sourceDocNo} <- origin not found` : `${c.sourceDocNo} <- ${first.sourceDocType} ${ac ? `AC ${ac.src} ${ac.doc}` : first.sourceDocNo ?? '-'}${ambiguous ? ' (ambiguous origin)' : ''}`,
      };
    });
    const cls = classifyLine({ hardBound, boundPoNos, costing });
    const exp = expectedUnitCost({
      grnLots: grnLots.filter((l) => l.itemCode === o.itemCode && bGrn.some((g) => g.grnId === l.grnId)),
      cutoverLayers: layers.filter((l) => l.itemCode === o.itemCode && bGrn.some((g) => g.acDoc === l.doc)),
      poLines: bound.filter((p) => p.currency === 'MYR').map((p) => ({ qty: p.received, unitCostSen: p.unitPriceSen })),
    });
    const costedQty = costing.reduce((s, c) => s + c.qty, 0);
    const ratio = costRatio(costing.reduce((s, c) => s + c.totalSen, 0), costedQty, exp.unitSen);
    return {
      ...o, group, hardBound, boundPoNos, boundGrns: [...new Set(bGrn.map((g) => `${g.grnNo}${g.migrated ? `(migrated, AC ${g.acDoc ?? '-'})` : ''}`))],
      allZero: costing.length > 0 && costing.every((c) => c.zero),
      costing, costedQty, ...cls, expSource: exp.source, ratio, same: sameCost(ratio),
    };
  });
}

function printRows(rows) {
  for (const r of rows.slice(0, LIMIT)) {
    console.log(`  ${r.repair ? '[repair] ' : ''}${r.doNo} | ${r.itemCode} @ ${r.wh ?? '-'} | vk "${r.vk}" | qty ${r.qty} costed ${r.costedQty} | ${r.group}${r.hardBound ? ' BOUND' : ''}`);
    console.log(`      bound PO ${r.boundPoNos.join(', ') || '-'} | GRN ${r.boundGrns.join(', ') || '-'}`);
    for (const c of r.costing) console.log(`      lot: ${c.qty} from ${c.src} -> PO ${c.pos.join(', ') || '-'}${c.zero ? ' [lot at zero]' : ''}`);
    console.log(`      => ${r.verdict}; ratio actual/expected ${r.ratio} (${r.expSource})${r.same === null ? '' : r.same ? ' same cost' : ' DIFFERENT cost'}`);
  }
  if (rows.length > LIMIT) console.log(`  ... ${rows.length - LIMIT} more (raise LIMIT)`);
}

function summary(label, rows) {
  notice(`${label}: ${rows.length} DO OUT row(s)`);
  for (const [v, desc] of VERDICTS) {
    const n = rows.filter((r) => r.verdict === v).length;
    if (n) console.log(`    ${String(n).padStart(6)}  ${v} — ${desc}`);
  }
  const priced = rows.filter((r) => r.hardBound && r.same !== null);
  const n = (f) => String(rows.filter(f).length);
  console.log(`    hard-bound rows with a ratio: ${String(priced.length)}; ratio 100% ${String(priced.filter((r) => r.same).length)}; ratio not 100% ${String(priced.filter((r) => !r.same).length)}`);
  console.log(`    hard-bound rows whose every costing lot is at zero: ${n((r) => r.hardBound && r.allZero)}; pooled rows the same: ${n((r) => !r.hardBound && r.allZero)}`);
  for (const v of ['match', 'mismatch', 'partial']) {
    const vr = priced.filter((r) => r.verdict === v);
    console.log(`    ${v}: ratio 100% ${String(vr.filter((r) => r.same).length)}, not 100% ${String(vr.filter((r) => !r.same).length)}`);
  }
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });
let failed = false;
try {
  await pg.begin('read only', async (sql) => {
    notice(`hard-bound cost vs lot: company ${CO}, REF ${REF}*, DO_NOS ${DO_NOS.length}, CENSUS ${CENSUS ? 'on' : 'off'}, cutover ${CUTOVER}`);

    console.log('\n-- A. DO OUTs costed from repair lots, and DO_NOS --');
    const fromRef = (await sql`
      SELECT DISTINCT c.movement_id::text AS id
        FROM scm.inventory_lot_consumptions c
        JOIN scm.inventory_lots l ON l.id = c.lot_id AND l.company_id = ${CO}
       WHERE l.source_doc_type = 'ADJUSTMENT' AND l.source_doc_no LIKE ${`${REF}%`} AND c.source_doc_type = 'DO'`).map((r) => r.id);
    const fromDos = DO_NOS.length === 0 ? [] : (await sql`
      SELECT m.id::text AS id FROM scm.inventory_movements m
        JOIN scm.delivery_orders d ON d.id = m.source_doc_id AND d.company_id = ${CO}
       WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND d.do_number = ANY(${DO_NOS})`).map((r) => r.id);
    notice(`  ${fromRef.length} OUT(s) still consume a ${REF}* lot; ${fromDos.length} OUT(s) on the ${DO_NOS.length} named DO(s)`);
    const refSet = new Set(fromRef);
    const rowsA = (await analyse(sql, [...new Set([...fromRef, ...fromDos])])).map((r) => ({ ...r, repair: refSet.has(r.id) }));
    rowsA.sort((a, b) => a.doNo.localeCompare(b.doNo, undefined, { numeric: true }) || a.itemCode.localeCompare(b.itemCode));
    summary('A', rowsA);
    summary('A, repair-costed rows only', rowsA.filter((r) => r.repair));
    console.log(`  distinct DOs: ${new Set(rowsA.map((r) => r.doNo)).size} — ${[...new Set(rowsA.map((r) => r.doNo))].join(', ') || '-'}`);
    printRows(rowsA);

    if (CENSUS) {
      console.log(`\n-- B. census: every company-${CO} DO OUT since ${CUTOVER} --`);
      const ids = (await sql`
        SELECT m.id::text AS id FROM scm.inventory_movements m
          JOIN scm.delivery_orders d ON d.id = m.source_doc_id AND d.company_id = ${CO}
         WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND m.created_at >= ${CUTOVER}
           AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'`).map((r) => r.id);
      const rowsB = [];
      for (const c of chunks(ids)) rowsB.push(...await analyse(sql, c));
      summary('B', rowsB);
      console.log('  hard-bound rows by group and verdict:');
      for (const [k, n] of tally(rowsB.filter((r) => r.hardBound), (r) => `${String(r.group).toLowerCase()} / ${r.verdict}`)) console.log(`    ${String(n).padStart(6)}  ${k}`);
      console.log('  mismatch / partial examples:');
      printRows(rowsB.filter((r) => r.verdict === 'mismatch' || r.verdict === 'partial').slice(0, Math.min(LIMIT, 15)));
    }

    console.log(`\n-- C. negative buckets after ${CUTOVER}: hard-bound vs pooled --`);
    const buckets = await sql`
      WITH mv AS (
        SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk,
               SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS net,
               MAX(created_at) FILTER (WHERE movement_type = 'OUT') AS last_out
          FROM scm.inventory_movements WHERE company_id = ${CO} GROUP BY 1, 2, 3),
      lt AS (
        SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS open
          FROM scm.inventory_lots WHERE company_id = ${CO} GROUP BY 1, 2, 3)
      SELECT mv.item_code AS "itemCode", mv.warehouse_id::text AS "warehouseId", mv.vk,
             mv.net AS "movementNet", COALESCE(lt.open, 0) AS "lotOpen", mv.last_out AS "lastOutAt"
        FROM mv LEFT JOIN lt ON lt.item_code = mv.item_code AND lt.warehouse_id = mv.warehouse_id AND lt.vk = mv.vk`;
    const negative = buckets.filter((b) => isNegativeAfterCutover(b, CUTOVER));
    const codes = [...new Set(negative.map((b) => b.itemCode))];
    const groupOf = new Map((codes.length === 0 ? [] : await sql`
      SELECT i.item_code AS "itemCode", mode() WITHIN GROUP (ORDER BY i.item_group) AS "itemGroup"
        FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
       WHERE d.company_id = ${CO} AND i.item_code = ANY(${codes}) GROUP BY 1`).map((r) => [r.itemCode, r.itemGroup]));
    const unc = codes.length === 0 ? [] : await sql`
      SELECT m.item_code AS "itemCode", m.warehouse_id::text AS "warehouseId", COALESCE(m.variant_key, '') AS vk,
             SUM(ABS(m.qty) - COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id), 0))::int AS short
        FROM scm.inventory_movements m
       WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND m.item_code = ANY(${codes})
       GROUP BY 1, 2, 3`;
    const shortOf = new Map(unc.map((u) => [`${u.itemCode}\u0001${u.warehouseId}\u0001${u.vk}`, Number(u.short)]));
    const classed = negative.map((b) => ({
      ...b, group: String(groupOf.get(b.itemCode) ?? '(no DO line)').toLowerCase(),
      hardBound: isHardBoundLine(groupOf.get(b.itemCode) ?? null, b.itemCode),
      short: Math.max(0, shortOf.get(`${b.itemCode}\u0001${b.warehouseId}\u0001${b.vk}`) ?? 0),
    }));
    const hb = classed.filter((b) => b.hardBound);
    notice(`  ${negative.length} negative bucket(s): ${hb.length} on hard-bound items (readiness reads the bound PO, not this bucket), ${negative.length - hb.length} on pooled items (readiness reads this bucket)`);
    console.log(`  uncosted DO OUT units: hard-bound ${hb.reduce((s, b) => s + b.short, 0)}, pooled ${classed.filter((b) => !b.hardBound).reduce((s, b) => s + b.short, 0)}`);
    for (const [k, n] of tally(classed, (b) => `${b.hardBound ? 'BOUND ' : 'pooled'} ${b.group}`)) console.log(`    ${String(n).padStart(6)}  ${k}`);
  });
} catch (e) {
  failed = true;
  console.error(`query failed: ${e.message}`);
} finally {
  await pg.end({ timeout: 5 });
}
if (failed) process.exit(1);
