
import {
  outstandingCommitments,
  type CommittedShipmentRow,
  type OutstandingCommitment,
} from './ship-commitment';
import { chunkIn } from './paginate-all';

export const WH_NONE = 'NOWH';
export const composite = (whId: string | null, code: string, vkey: string): string =>
  `${whId ?? WH_NONE}|${code}|${vkey}`;

export async function loadCommittedShipments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scoped: <Q>(q: Q) => Q,
  poNumbers: string[],
): Promise<Map<string, OutstandingCommitment>> {
  const batches = [...new Set(poNumbers.filter(Boolean))];
  if (batches.length === 0) return new Map();
  try {
    type MovRow = {
      id: string; warehouse_id: string | null; item_code: string;
      variant_key: string | null; batch_no: string | null; qty: number; source_doc_id: string | null;
    };
    const { data: movs, error: movErr } = await chunkIn<MovRow>(batches, (batch, from, to) =>
      scoped(sb.from('inventory_movements')
        .select('id, warehouse_id, item_code, variant_key, batch_no, qty, source_doc_id')
        .eq('movement_type', 'OUT')
        .eq('source_doc_type', 'DO')
        .in('batch_no', batch))
        .order('id')
        .range(from, to));
    if (movErr) return new Map();
    if (movs.length === 0) return new Map();

    const doIds = [...new Set(movs.map((m) => m.source_doc_id).filter((x): x is string => !!x))];
    const movIds = movs.map((m) => m.id);

    type DoRow = { id: string; status: string | null; is_dropship: boolean | null };
    const { data: doRows, error: doErr } = await chunkIn<DoRow>(doIds, (batch, from, to) =>
      scoped(sb.from('delivery_orders').select('id, status, is_dropship').in('id', batch))
        .order('id')
        .range(from, to));
    if (doErr) return new Map();
    const doById = new Map(doRows.map((d) => [d.id, d]));

    type LineRow = {
      delivery_order_id: string; item_code: string;
      committed_po_batch_no: string; committed_variant_key: string | null;
    };
    const { data: lineRows, error: lineErr } = await chunkIn<LineRow>(doIds, (batch, from, to) =>
      scoped(sb.from('delivery_order_items')
        .select('delivery_order_id, item_code, committed_po_batch_no, committed_variant_key')
        .in('delivery_order_id', batch)
        .not('committed_po_batch_no', 'is', null))
        .order('delivery_order_id')
        .range(from, to));
    if (lineErr) return new Map();
    const committedLines = new Set(
      lineRows.map((r) => `${r.delivery_order_id}|${r.item_code}|${r.committed_variant_key ?? ''}|${r.committed_po_batch_no}`),
    );

    type ConsRow = { movement_id: string; qty_consumed: number };
    const { data: cons, error: consErr } = await chunkIn<ConsRow>(movIds, (batch, from, to) =>
      sb.from('inventory_lot_consumptions')
        .select('movement_id, qty_consumed')
        .in('movement_id', batch)
        .order('movement_id')
        .range(from, to));
    if (consErr) return new Map();
    const consumedByMovement = new Map<string, number>();
    for (const r of cons) {
      consumedByMovement.set(r.movement_id, (consumedByMovement.get(r.movement_id) ?? 0) + Number(r.qty_consumed ?? 0));
    }

    const rows: CommittedShipmentRow[] = [];
    for (const m of movs) {
      if (!m.batch_no || !m.source_doc_id) continue;
      const d = doById.get(m.source_doc_id);
      const variantKey = m.variant_key ?? '';
      rows.push({
        bucketKey: composite(m.warehouse_id ?? null, m.item_code, variantKey),
        warehouseId: m.warehouse_id ?? null,
        itemCode: m.item_code,
        variantKey,
        batchNo: m.batch_no,
        outQty: Math.abs(Number(m.qty ?? 0)),
        consumedQty: consumedByMovement.get(m.id) ?? 0,
        cancelled: !d || (d.status ?? '').toUpperCase() === 'CANCELLED',
        headerDropship: d?.is_dropship === true,
        lineCommitted: committedLines.has(`${m.source_doc_id}|${m.item_code}|${variantKey}|${m.batch_no}`),
      });
    }
    return outstandingCommitments(rows);
  } catch {
    return new Map();
  }
}
