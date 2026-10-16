// do-line-racks — the RACK column on the DO detail / printed DO.
//
// A DO line names the rack(s) its goods were received onto by ITS OWN source
// PO's GRN, never every rack that happens to hold the same product code in the
// warehouse (BUG-102, Sim 2026-10-10: HC-DO-2610-156 printed six racks against
// two JAGER-(Q) bedframes whose GRNs recorded none). A GRN line saved without a
// rack places nothing, so that line prints a dash.
//
// Placement → PO: warehouse_rack_items.source_grn_id → grn_items (same grn,
// item_code, rack_id).purchase_order_item_id → purchase_order_items
// .purchase_order_id, falling back to grns.purchase_order_id (a multi-PO GRN's
// header names only its first PO). Manual stock-in placements carry no GRN and
// are not attributed to any PO. An operator's explicit pick
// (delivery_order_items.rack_id) wins over all of this.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { pgrestIn } from './pgrest-in-list';

const CHUNK = 200;

export type DoLineRacks = {
  /** `${warehouse_id}::${item_code}::${po_number}` → rack labels, sorted. */
  byPo: Map<string, string[]>;
  /** Every rack in the ship-from warehouse(s): id → label. */
  labelById: Map<string, string>;
};

async function readIn<T>(
  sb: any, table: string, cols: string, column: string, values: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    const { data, error } = await pgrestIn(sb.from(table).select(cols), column, values.slice(i, i + CHUNK));
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export async function resolveDoLineRacks(
  sb: any,
  rawItems: Array<{ id: string } & Record<string, unknown>>,
  lineWh: Map<string, string | null>,
): Promise<DoLineRacks> {
  const byPo = new Map<string, string[]>();
  const labelById = new Map<string, string>();
  try {
    const whIds = new Set<string>();
    const codes = new Set<string>();
    for (const it of rawItems) {
      const wid = lineWh.get(it.id) ?? null;
      const code = (it.item_code as string | null) ?? null;
      if (!wid || !code) continue;
      whIds.add(wid);
      codes.add(code);
    }
    if (whIds.size === 0) return { byPo, labelById };

    const racks = await readIn<{ id: string; rack: string | null; warehouse_id: string | null }>(
      sb, 'warehouse_racks', 'id, rack, warehouse_id', 'warehouse_id', [...whIds]);
    const whByRack = new Map<string, string>();
    for (const r of racks) {
      if (!r.rack || !r.warehouse_id) continue;
      labelById.set(r.id, r.rack);
      whByRack.set(r.id, r.warehouse_id);
    }
    if (labelById.size === 0 || codes.size === 0) return { byPo, labelById };

    const placements = (await readIn<{ rack_id: string; item_code: string; source_grn_id: string | null }>(
      sb, 'warehouse_rack_items', 'rack_id, item_code, source_grn_id', 'item_code', [...codes],
    )).filter((p) => p.source_grn_id && whByRack.has(p.rack_id));
    if (placements.length === 0) return { byPo, labelById };

    const grnIds = [...new Set(placements.map((p) => p.source_grn_id as string))];
    const [grnLines, grnHeads] = await Promise.all([
      readIn<{ grn_id: string; item_code: string | null; rack_id: string | null; purchase_order_item_id: string | null }>(
        sb, 'grn_items', 'grn_id, item_code, rack_id, purchase_order_item_id', 'grn_id', grnIds),
      readIn<{ id: string; purchase_order_id: string | null }>(sb, 'grns', 'id, purchase_order_id', 'id', grnIds),
    ]);
    const poItemIds = [...new Set(grnLines.map((g) => g.purchase_order_item_id).filter((x): x is string => !!x))];
    const poItems = poItemIds.length > 0
      ? await readIn<{ id: string; purchase_order_id: string | null }>(
        sb, 'purchase_order_items', 'id, purchase_order_id', 'id', poItemIds)
      : [];
    const poIdByPoItem = new Map(poItems.map((p) => [p.id, p.purchase_order_id]));
    const headPoByGrn = new Map(grnHeads.map((g) => [g.id, g.purchase_order_id]));

    const poIdsByPlacement = new Map<string, Set<string>>();
    for (const g of grnLines) {
      const poId = (g.purchase_order_item_id ? poIdByPoItem.get(g.purchase_order_item_id) : null)
        ?? headPoByGrn.get(g.grn_id) ?? null;
      if (!poId || !g.rack_id || !g.item_code) continue;
      const k = `${g.grn_id}::${g.item_code}::${g.rack_id}`;
      const set = poIdsByPlacement.get(k) ?? new Set<string>();
      set.add(poId);
      poIdsByPlacement.set(k, set);
    }
    const allPoIds = [...new Set([...poIdsByPlacement.values()].flatMap((s) => [...s]))];
    const pos = allPoIds.length > 0
      ? await readIn<{ id: string; po_number: string | null }>(sb, 'purchase_orders', 'id, po_number', 'id', allPoIds)
      : [];
    const poNoById = new Map(pos.map((p) => [p.id, p.po_number]));

    const sets = new Map<string, Set<string>>();
    for (const p of placements) {
      const poIds = poIdsByPlacement.get(`${p.source_grn_id}::${p.item_code}::${p.rack_id}`);
      if (!poIds) continue;
      for (const poId of poIds) {
        const poNo = poNoById.get(poId);
        if (!poNo) continue;
        const k = `${whByRack.get(p.rack_id)}::${p.item_code}::${poNo}`;
        const set = sets.get(k) ?? new Set<string>();
        set.add(labelById.get(p.rack_id) as string);
        sets.set(k, set);
      }
    }
    for (const [k, set] of sets) byPo.set(k, [...set].sort());
  } catch { /* rack / GRN tables unreadable — every line shows a dash */ }
  return { byPo, labelById };
}

/** Rack label(s) for one DO line: the operator's pick, else the racks its
 *  source PO(s) were received onto in its ship-from warehouse. */
export function racksForDoLine(
  r: DoLineRacks,
  line: { warehouseId: string | null; itemCode: string | null; rackId: string | null; sourcePos: readonly string[] },
): string[] {
  const picked = line.rackId ? r.labelById.get(line.rackId) : undefined;
  if (picked) return [picked];
  if (!line.warehouseId || !line.itemCode) return [];
  const out = new Set<string>();
  for (const po of line.sourcePos) {
    for (const rack of r.byPo.get(`${line.warehouseId}::${line.itemCode}::${po}`) ?? []) out.add(rack);
  }
  return [...out].sort();
}
