// hard-bound-cost-batch — a company-1 hard-bound DO line is costed from its own PO.
//
// OWNER DECISION A (2026-11-10): for Houzs Century a hard-bound sales line's cost
// of goods comes from the receipt of the PO bound to it (GRN price, later the PI
// price), not from plain FIFO over the warehouse + item + spec bucket. Readiness
// already follows the binding (isHardBoundLine / HARD_BOUND_COMPANY_ID in
// so-stock-allocation.ts). Cost did not: only a sofa line with a locked dye lot
// carried batch_no on its OUT, so every other bound line took the oldest open lot
// of any PO (PR #5614: 47 of 1,221 bound OUTs costed from another PO, 52 from a
// lot naming no PO).
//
// The mechanism is the one sofa already uses. The OUT carries batch_no = the
// bound PO number; the FIFO trigger (fn_inventory_movement_fifo) then consumes
// that PO's lot first (fn_consume_fifo_batch) and falls back to plain FIFO for
// any residual (migration 0195). recostFromGrn / recostForPi reprice the lot and
// push the change through the consumption to this DO, so the PI price lands on
// the right DO.
//
// DECIDED ONCE, AT SHIP. The first ship decides; every later seam (the resync
// after a line edit, the restamp after a PI) reads the batch the DO's own OUT was
// stamped with, the same "stored answer" rule committed_po_batch_no follows. A PO
// cancelled or received after the ship therefore never moves a bucket.
//
// NEVER BLOCKS A SHIPMENT. When the bound PO has no open lot in that warehouse
// under that item + spec, or two lines would collide in one OUT row, the line
// ships exactly as before (no batch, plain FIFO) and the reason is written on the
// OUT movement's notes, prefixed HARD_BOUND_COST_NOTE, for the backfill to find.
//
// Company 2 (2990) pools: for any company other than HARD_BOUND_COMPANY_ID this
// module returns an empty answer without reading anything.

import { HARD_BOUND_COMPANY_ID, isHardBoundLine } from './so-stock-allocation';
import { receivedBoundPosBySoItem } from './source-po-trace';
import { chunkIn } from './paginate-all';

export const HARD_BOUND_COST_NOTE = 'Hard-bound cost:';

export type CostBatchLine = {
  soItemId: string | null;
  itemCode: string;
  itemGroup: string | null;
  variantKey: string;
  warehouseId: string | null;
  qty: number;
};

export type CostBatchReason =
  /* no live PO bound to this SO line has received this item */
  | 'no-received-bound-po'
  /* the bound PO has no open lot in this warehouse under this item + spec */
  | 'own-po-lot-not-here'
  /* the batch was stamped, but the PO's open lots hold fewer units than the line;
     the trigger costs the rest from plain FIFO */
  | 'own-po-lot-short'
  /* another line of this DO ships the same item + spec under a different batch;
     one OUT row per (DO, item, spec) is a unique index, so both stay as they were */
  | 'shared-bucket';

export type CostBatchNote = {
  soItemId: string;
  itemCode: string;
  variantKey: string;
  warehouseId: string;
  reason: CostBatchReason;
  poNumbers: string[];
};

export type CostBatchMode = 'ship' | 'resync' | 'restamp';

const bucketOf = (wh: string, code: string, vk: string): string => `${wh}::${code}::${vk}`;

/** The pure decision. `stamped` is null on the first ship (no OUT yet); otherwise
 *  it maps `${wh}::${item}::${vk}` to the batch_no this DO's first-ship OUT row
 *  carries (null = shipped un-batched). `openQty` maps `${wh}::${item}::${vk}::${po}`
 *  to the open qty of that PO's lots. */
export function pickHardBoundCostBatches(input: {
  companyId: number | null;
  lines: ReadonlyArray<CostBatchLine>;
  already: ReadonlyMap<string, string>;
  stamped: ReadonlyMap<string, string | null> | null;
  boundPos: ReadonlyMap<string, ReadonlyArray<{ itemCode: string; poNumber: string }>>;
  openQty: ReadonlyMap<string, number>;
  allowDecide: boolean;
}): { batchBySoItem: Map<string, string>; notes: CostBatchNote[] } {
  const batchBySoItem = new Map<string, string>();
  const notes: CostBatchNote[] = [];
  if (input.companyId !== HARD_BOUND_COMPANY_ID) return { batchBySoItem, notes };

  const decided = new Map<string, { po: string; line: CostBatchLine & { warehouseId: string } }>();
  for (const line of input.lines) {
    const sid = line.soItemId;
    const wh = line.warehouseId;
    if (!sid || !wh || !(line.qty > 0)) continue;
    if (!isHardBoundLine(line.itemGroup, line.itemCode)) continue;
    if (input.already.has(sid) || batchBySoItem.has(sid) || decided.has(sid)) continue;
    const bk = bucketOf(wh, line.itemCode, line.variantKey);
    if (input.stamped && input.stamped.has(bk)) {
      const b = input.stamped.get(bk) ?? null;
      if (b) batchBySoItem.set(sid, b);
      continue;
    }
    if (!input.allowDecide) continue;
    const base = { soItemId: sid, itemCode: line.itemCode, variantKey: line.variantKey, warehouseId: wh };
    const candidates = [...new Set((input.boundPos.get(sid) ?? [])
      .filter((b) => b.itemCode === line.itemCode)
      .map((b) => b.poNumber))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (candidates.length === 0) {
      notes.push({ ...base, reason: 'no-received-bound-po', poNumbers: [] });
      continue;
    }
    const open = candidates.map((po) => ({ po, qty: input.openQty.get(`${bk}::${po}`) ?? 0 })).filter((c) => c.qty > 0);
    if (open.length === 0) {
      notes.push({ ...base, reason: 'own-po-lot-not-here', poNumbers: candidates });
      continue;
    }
    const full = open.find((c) => c.qty >= line.qty);
    const pick = full ?? open.reduce((a, b) => (b.qty > a.qty ? b : a));
    if (!full) notes.push({ ...base, reason: 'own-po-lot-short', poNumbers: [pick.po] });
    decided.set(sid, { po: pick.po, line: { ...line, warehouseId: wh } });
  }

  /* One OUT row per (DO, item_code, variant_key) on the first ship
     (uq_inv_mov_do_source_v2 has no warehouse and no batch in its key). Two lines
     of that pair under different batches would make the whole insert fail and the
     stock never leave, so the decision is dropped for that pair. Resync rows carry
     correction_seq and do not collide. */
  if (input.stamped === null && decided.size > 0) {
    const finalByPair = new Map<string, Set<string>>();
    for (const line of input.lines) {
      if (!line.warehouseId || !(line.qty > 0)) continue;
      const sid = line.soItemId;
      const b = sid ? (input.already.get(sid) ?? decided.get(sid)?.po ?? '') : '';
      const pair = `${line.itemCode}::${line.variantKey}`;
      const set = finalByPair.get(pair) ?? new Set<string>();
      set.add(b);
      finalByPair.set(pair, set);
    }
    for (const [sid, d] of [...decided]) {
      const pair = `${d.line.itemCode}::${d.line.variantKey}`;
      if ((finalByPair.get(pair)?.size ?? 0) > 1) {
        decided.delete(sid);
        for (let i = notes.length - 1; i >= 0; i--) if (notes[i]!.soItemId === sid) notes.splice(i, 1);
        notes.push({ soItemId: sid, itemCode: d.line.itemCode, variantKey: d.line.variantKey, warehouseId: d.line.warehouseId, reason: 'shared-bucket', poNumbers: [d.po] });
      }
    }
  }
  for (const [sid, d] of decided) batchBySoItem.set(sid, d.po);
  return { batchBySoItem, notes };
}

export type StampRow = {
  movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null;
  batch_no: string | null; qty: number | null; correction_seq: number | null;
};

/** Per `${wh}::${item}::${vk}` bucket of one DO, the batch its units are out
 *  under: the one batch whose OUT minus IN is still positive. A DO re-costed by
 *  backfill-hard-bound-cost.mjs returned its un-batched units and took them again
 *  under the bound PO, so its positive batch is no longer the first-ship row's.
 *  With no single positive batch (nothing out, or two batches out) the
 *  first-ship row's batch stands, as before. */
export function stampedBatchByBucket(rows: ReadonlyArray<StampRow>): Map<string, string | null> {
  const net = new Map<string, Map<string, number>>();
  const firstShip = new Map<string, string | null>();
  for (const m of rows) {
    const bk = bucketOf(m.warehouse_id, m.item_code, m.variant_key ?? '');
    const b = m.batch_no ?? '';
    const sign = m.movement_type === 'OUT' ? 1 : m.movement_type === 'IN' ? -1 : 0;
    if (sign === 0) continue;
    const byBatch = net.get(bk) ?? new Map<string, number>();
    byBatch.set(b, (byBatch.get(b) ?? 0) + sign * Math.abs(Number(m.qty ?? 0)));
    net.set(bk, byBatch);
    if (m.movement_type === 'OUT' && (m.correction_seq ?? 0) === 0) firstShip.set(bk, m.batch_no ?? null);
    else if (m.movement_type === 'OUT' && !firstShip.has(bk)) firstShip.set(bk, m.batch_no ?? null);
  }
  const out = new Map<string, string | null>();
  for (const [bk, byBatch] of net) {
    const positive = [...byBatch].filter(([, q]) => q > 0);
    if (positive.length === 1) out.set(bk, positive[0]![0] || null);
    else if (firstShip.has(bk)) out.set(bk, firstShip.get(bk) ?? null);
  }
  return out;
}

/** The movement note for one OUT bucket, or null when nothing fell back. */
export function costBatchNoteText(notes: ReadonlyArray<CostBatchNote>): string | null {
  if (notes.length === 0) return null;
  const parts = [...new Set(notes.map((n) => `${n.reason}${n.poNumbers.length ? ` (${n.poNumbers.join(', ')})` : ''}`))];
  return `${HARD_BOUND_COST_NOTE} ${parts.join('; ')}`;
}

/** The DB half. Ship: decides from the bound POs and their open lots. Resync:
 *  reads the stamped batch of every bucket already shipped and decides only for
 *  a bucket with no OUT yet (a line added after the ship). Restamp: reads only.
 *
 *  A failed read on the ship path falls back to the old behaviour (no batch);
 *  costing never blocks a shipment. On resync / restamp a failed read of the
 *  DO's own OUT rows THROWS: keying a bucket without its stamped batch would
 *  return the units of one bucket and take them again in another. */
export async function resolveHardBoundCostBatches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST shim has no honest type for the SCM tables
  sb: any,
  args: {
    companyId: number | null;
    deliveryOrderId: string;
    lines: ReadonlyArray<CostBatchLine>;
    already: ReadonlyMap<string, string>;
    mode: CostBatchMode;
  },
): Promise<{ batchBySoItem: Map<string, string>; notes: CostBatchNote[] }> {
  const empty = { batchBySoItem: new Map<string, string>(), notes: [] as CostBatchNote[] };
  if (args.companyId !== HARD_BOUND_COMPANY_ID) return empty;
  const eligible = args.lines.filter((l) => l.soItemId && l.warehouseId && l.qty > 0
    && isHardBoundLine(l.itemGroup, l.itemCode) && !args.already.has(l.soItemId));
  if (eligible.length === 0) return empty;

  let stamped: Map<string, string | null> | null = null;
  if (args.mode !== 'ship') {
    const { data, error } = await sb.from('inventory_movements')
      .select('movement_type, warehouse_id, item_code, variant_key, batch_no, qty, correction_seq')
      .eq('source_doc_type', 'DO')
      .eq('source_doc_id', args.deliveryOrderId)
      .in('movement_type', ['OUT', 'IN']);
    if (error) throw new Error(`hard-bound cost: the DO's stock movements could not be read: ${error.message}`);
    stamped = stampedBatchByBucket((data ?? []) as StampRow[]);
  }
  const allowDecide = args.mode !== 'restamp';
  const toDecide = eligible.filter((l) => !stamped || !stamped.has(bucketOf(l.warehouseId!, l.itemCode, l.variantKey)));

  let boundPos = new Map<string, Array<{ itemCode: string; poNumber: string }>>();
  const openQty = new Map<string, number>();
  let readFailed = false;
  if (allowDecide && toDecide.length > 0) {
    try {
      boundPos = await receivedBoundPosBySoItem(sb, toDecide.map((l) => l.soItemId));
      const poNos = [...new Set([...boundPos.values()].flat().map((b) => b.poNumber))];
      const codes = new Set(toDecide.map((l) => l.itemCode));
      if (poNos.length > 0) {
        const { data, error } = await chunkIn<{ warehouse_id: string; item_code: string; variant_key: string | null; batch_no: string; qty_remaining: number }>(
          poNos, (batch, from, to) => sb.from('inventory_lots')
            .select('warehouse_id, item_code, variant_key, batch_no, qty_remaining')
            .eq('company_id', HARD_BOUND_COMPANY_ID)
            .in('batch_no', batch)
            .gt('qty_remaining', 0)
            .order('id')
            .range(from, to));
        if (error) throw new Error(error.message);
        for (const r of data) {
          if (!codes.has(r.item_code)) continue;
          const k = `${bucketOf(r.warehouse_id, r.item_code, r.variant_key ?? '')}::${r.batch_no}`;
          openQty.set(k, (openQty.get(k) ?? 0) + Number(r.qty_remaining));
        }
      }
    } catch (e) {
      /* eslint-disable-next-line no-console */
      console.warn('[hard-bound-cost] bound PO / lot read failed, shipping on plain FIFO:', args.deliveryOrderId, e instanceof Error ? e.message : e);
      readFailed = true;
    }
  }
  return pickHardBoundCostBatches({
    companyId: args.companyId, lines: args.lines, already: args.already,
    stamped, boundPos, openQty, allowDecide: allowDecide && !readFailed,
  });
}
