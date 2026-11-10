/* hard-bound-cost-analyse — the DB half of check-hard-bound-cost-vs-lot.mjs,
 * shared with backfill-hard-bound-cost.mjs so the backfill selects lines by the
 * verdicts the check prints. Moved here unchanged, plus what the backfill needs:
 * the OUT's warehouse id, batch, correction_seq and month, and each costing
 * lot's id, batch and source doc. SELECTs only; every query names company_id.
 * Costs leave only as a ratio. */
import { computeVariantKey } from '../../src/scm/shared/variant-key.ts';
import { isHardBoundLine } from '../../src/scm/lib/so-stock-allocation.ts';
import {
  DEFAULT_REF_PREFIX, parseAcDoc, originCandidates, lotPos, classifyLine, expectedUnitCost,
  costRatio, sameCost, acGrOfMigratedGrn,
} from './hard-bound-cost-check.mjs';

const CHUNK = 2000;
export const chunkList = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; };
const keyOf = (g, v) => computeVariantKey(g, v && typeof v === 'object' ? v : {});

async function many(ids, fn) {
  const out = [];
  for (const c of chunkList(ids)) out.push(...await fn(c));
  return out;
}

/* Every DO OUT in `movementIds`, resolved to one result row per OUT. */
export async function analyseHardBoundOuts(sql, CO, movementIds) {
  if (movementIds.length === 0) return [];
  const outs = await many(movementIds, (c) => sql`
    SELECT m.id::text AS id, m.source_doc_id::text AS "doId", d.do_number AS "doNo", m.item_code AS "itemCode",
           COALESCE(m.variant_key, '') AS vk, COALESCE(w.code, w.name) AS wh, ABS(m.qty)::int AS qty,
           m.warehouse_id::text AS "warehouseId", m.batch_no AS "outBatch", COALESCE(m.correction_seq, 0)::int AS seq,
           to_char(COALESCE(m.movement_date, m.created_at::date), 'YYYY-MM-DD') AS "outDate"
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
    SELECT substring(g.grn_number from '^HC-(GR-[0-9]+)') AS doc, po.po_number AS "poNo"
      FROM scm.grns g JOIN scm.purchase_orders po ON po.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND substring(g.grn_number from '^HC-(GR-[0-9]+)') = ANY(${c})`)) {
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
  for (const g of grnLines) g.acGr = acGrOfMigratedGrn(g.grnNo);
  const boundAcDocs = [...new Set(grnLines.map((g) => g.acGr).filter(Boolean))];
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
      const lot = { lotId: c.lotId, lotBatch: c.batchNo ?? null, lotDocNo: c.sourceDocNo ?? null };
      if (!origins) return { ...lot, qty: c.qty, totalSen: Number(c.totalSen), zero, pos: lotPos(c, poByGrnId, poByAcDoc), src: `${c.sourceDocType ?? '-'} ${c.sourceDocNo ?? '-'}` };
      const posSets = origins.map((x) => lotPos(x, poByGrnId, poByAcDoc).join('+'));
      const ambiguous = new Set(posSets).size > 1;
      const first = origins[0];
      const ac = first ? parseAcDoc(first.movementNotes) : null;
      return {
        ...lot, qty: c.qty, totalSen: Number(c.totalSen), zero,
        pos: !first || ambiguous ? [] : lotPos(first, poByGrnId, poByAcDoc),
        src: !first ? `${c.sourceDocNo} <- origin not found` : `${c.sourceDocNo} <- ${first.sourceDocType} ${ac ? `AC ${ac.src} ${ac.doc}` : first.sourceDocNo ?? '-'}${ambiguous ? ' (ambiguous origin)' : ''}`,
      };
    });
    const cls = classifyLine({ hardBound, boundPoNos, costing });
    const exp = expectedUnitCost({
      grnLots: grnLots.filter((l) => l.itemCode === o.itemCode && bGrn.some((g) => g.grnId === l.grnId)),
      cutoverLayers: layers.filter((l) => l.itemCode === o.itemCode && bGrn.some((g) => g.acGr === l.doc)),
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

