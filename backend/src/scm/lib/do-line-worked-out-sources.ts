// do-line-worked-out-sources — the Source PO(s) and Rack(s) a delivery-order line
// is WORKED OUT to come from, for a batch of DOs. One rule, read by the DO detail
// (GET /delivery-orders-mfg/:id) and the packing list (GET /trips/packing*).
//
// Per line, in order:
//   PO   = the stock-ledger trace of this DO's OUT for the line's bucket
//          (source-po-trace.ts), else — when the trace found neither a PO nor an
//          adjustment — the PO bound to the line's SO line (latest live one).
//   Rack = the operator's picked rack, else the rack this DO stocked the goods out
//          of, else the racks the line's source PO(s) were received onto in its
//          ship-from warehouse (do-line-racks.ts).
// A line's dispatch stamp (delivery_order_items.shipped_from) is NOT read here:
// each reader lets a fitting stamp win and marks everything else worked out.
//
// Query count does not grow with the number of DOs: every read is one statement
// per id chunk (see do-line-worked-out-sources.test.ts for the measured count).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { computeVariantKey, type VariantAttrs } from '../shared';
import { traceDoShipmentSources } from './source-po-trace';
import { resolveExpectedBatchBySoItem } from './dropship-batch';
import { resolveDoLineRacks, racksForDoLine, loadShippedFromRacksByDo } from './do-line-racks';
import { resolveDoLineWarehousesForDos } from './do-line-warehouses';

export type WorkedOutDo = {
  id: string;
  do_number: string | null;
  warehouse_id: string | null;
  /** The company whose default warehouse a line falls back to. */
  company_id: number | undefined;
};

export type WorkedOutLineInput = {
  id: string;
  delivery_order_id: string;
  item_code: string | null;
  item_group: string | null;
  variants: VariantAttrs | null;
  so_item_id: string | null;
  rack_id: string | null;
};

export type WorkedOutSource = { source_pos: string[]; source_adj: boolean; racks: string[] };

export type WorkedOutSources = {
  /** line id -> ship-from warehouse (SO line, else DO header, else company default). */
  lineWh: Map<string, string | null>;
  byLine: Map<string, WorkedOutSource>;
};

/**
 * `scopedRackMoves` builds the caller's company-scoped
 * `select('source_doc_no, item_code, rack_label')` on `warehouse_rack_movements`;
 * every other read is keyed on ids the caller already read under its company
 * predicate (the DOs, their lines, and what those lines point at).
 */
export async function resolveWorkedOutSources(
  sb: any,
  dos: readonly WorkedOutDo[],
  lines: readonly WorkedOutLineInput[],
  scopedRackMoves: () => any,
): Promise<WorkedOutSources> {
  const doById = new Map(dos.map((d) => [d.id, d]));
  const [lineWh, trace] = await Promise.all([
    resolveDoLineWarehousesForDos(sb, lines, (l) => {
      const d = doById.get(l.delivery_order_id);
      return { warehouseId: d?.warehouse_id ?? null, companyId: d?.company_id };
    }),
    traceDoShipmentSources(sb, dos.map((d) => d.id)),
  ]);
  const rackItems: Array<{ id: string } & Record<string, unknown>> = lines.map((l) => ({ ...l }));
  const [doRacks, shippedByDo] = await Promise.all([
    resolveDoLineRacks(sb, rackItems, lineWh),
    loadShippedFromRacksByDo(scopedRackMoves, dos.map((d) => d.do_number)),
  ]);

  const bucketOf = (l: WorkedOutLineInput): string =>
    `${l.delivery_order_id}::${l.item_code ?? ''}::${computeVariantKey(l.item_group ?? null, l.variants ?? null)}`;
  const traceOf = (l: WorkedOutLineInput) => trace.byBucket.get(bucketOf(l));
  const unresolvedSoIds = lines
    .filter((l) => {
      const t = traceOf(l);
      return !t || (t.pos.length === 0 && t.adjQty <= 0);
    })
    .map((l) => l.so_item_id)
    .filter((x): x is string => Boolean(x));
  const boundPoBySoItem = unresolvedSoIds.length > 0
    ? await resolveExpectedBatchBySoItem(sb, unresolvedSoIds, { onMultiPo: 'latest' })
    : new Map<string, { poNumber: string }>();

  const byLine = new Map<string, WorkedOutSource>();
  for (const l of lines) {
    const t = traceOf(l) ?? { pos: [], adjQty: 0 };
    const boundPo = t.pos.length === 0 && t.adjQty <= 0 && l.so_item_id
      ? (boundPoBySoItem.get(l.so_item_id)?.poNumber ?? null)
      : null;
    const sourcePos = t.pos.length > 0 ? [...t.pos] : (boundPo ? [boundPo] : []);
    const doNo = doById.get(l.delivery_order_id)?.do_number ?? null;
    const racks = racksForDoLine(doRacks, {
      warehouseId: lineWh.get(l.id) ?? null,
      itemCode: l.item_code,
      rackId: l.rack_id,
      sourcePos,
    }, shippedByDo && doNo ? (shippedByDo.get(doNo) ?? null) : null);
    byLine.set(l.id, { source_pos: sourcePos, source_adj: t.adjQty > 0, racks });
  }
  return { lineWh, byLine };
}
