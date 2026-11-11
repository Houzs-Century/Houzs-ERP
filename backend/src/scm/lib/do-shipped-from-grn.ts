// do-shipped-from-grn — what each GRN line of the given POs recorded per rack,
// for the shipped_from stamp's fallback when a DO line left no dispatch rack.
//
// Owner rule 2026-11-10: "看拿什么PO的货，然后看是什么GR，然后看在GR的什么rack".
// PO -> its GRN line(s) for the item (grn_items.purchase_order_item_id, or the
// GRN header's PO for a line saved without one) -> the rack(s) that line
// recorded: the grn_item_racks split when it has one, else grn_items.rack_id
// holding qty_accepted (the same rule the GRN post placed by, planGrnPlacements).
// Only POSTED GRNs placed goods. A rack outside the DO line's ship-from
// warehouse never qualifies; the planner matches the warehouse per line.
//
// Throws on any read error: the stamp is write-once, so a half-read chain must
// refuse the stamp rather than lock "no rack" for good.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { computeVariantKey, type VariantAttrs } from '../shared';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { pgrestIn } from './pgrest-in-list';
import { chunkIn } from './paginate-all';

export type GrnRackRow = {
  po: string; grn: string; grn_at: string; item_code: string; variant_key: string;
  warehouse_id: string; rack_id: string; label: string | null; qty: number;
};

async function readIn<T>(
  sb: any, table: string, cols: string, column: string, values: string[], companyId: number | null,
  extra?: (q: any) => any,
): Promise<T[]> {
  /* Each batch is PAGED (chunkIn): the GRN lines of a busy PO set pass
     PostgREST's 1,000-row page, and the rows past it were dropped without an
     error, so the DO's "shipped from" racks came out short. */
  const { data, error, truncated } = await chunkIn<T>(values, (part, from, to) => {
    let q = pgrestIn(scopeToCompanyIdOrOpen(sb.from(table).select(cols), companyId), column, part);
    if (extra) q = extra(q);
    return q.order('id').range(from, to);
  });
  if (error) throw new Error(`${table}: ${error.message}`);
  if (truncated) throw new Error(`${table}: too many rows to read in full`);
  return data;
}

type GrnLine = {
  id: string; grn_id: string; item_code: string | null; item_group: string | null; variants: VariantAttrs | null;
  rack_id: string | null; purchase_order_item_id: string | null; qty_accepted: number | null;
};
type GrnHead = { id: string; grn_number: string | null; warehouse_id: string | null; status: string | null; received_at: string | null; purchase_order_id: string | null };

export async function loadGrnRacksForPos(
  sb: any, poNumbers: string[], itemCodes: string[], warehouseIds: string[], companyId: number | null,
): Promise<GrnRackRow[]> {
  if (poNumbers.length === 0 || itemCodes.length === 0 || warehouseIds.length === 0) return [];
  const codes = new Set(itemCodes);
  const whs = new Set(warehouseIds);
  const pos = await readIn<{ id: string; po_number: string | null }>(
    sb, 'purchase_orders', 'id, po_number', 'po_number', poNumbers, companyId);
  if (pos.length === 0) return [];
  const poNoById = new Map(pos.map((p) => [p.id, p.po_number]));
  const poIds = [...poNoById.keys()];

  const lineCols = 'id, grn_id, item_code, item_group, variants, rack_id, purchase_order_item_id, qty_accepted';
  const headCols = 'id, grn_number, warehouse_id, status, received_at, purchase_order_id';
  const [poItems, headsByPo] = await Promise.all([
    readIn<{ id: string; purchase_order_id: string | null }>(sb, 'purchase_order_items', 'id, purchase_order_id', 'purchase_order_id', poIds, companyId),
    readIn<GrnHead>(sb, 'grns', headCols, 'purchase_order_id', poIds, companyId),
  ]);
  const poIdByPoItem = new Map(poItems.map((p) => [p.id, p.purchase_order_id]));
  const [linked, unlinked] = await Promise.all([
    readIn<GrnLine>(sb, 'grn_items', lineCols, 'purchase_order_item_id', [...poIdByPoItem.keys()], companyId),
    readIn<GrnLine>(sb, 'grn_items', lineCols, 'grn_id', headsByPo.map((h) => h.id), companyId,
      (q) => q.is('purchase_order_item_id', null)),
  ]);
  const lines = [...linked, ...unlinked].filter((g) => g.item_code && codes.has(g.item_code) && Number(g.qty_accepted ?? 0) > 0);
  if (lines.length === 0) return [];

  const heads = new Map(headsByPo.map((h) => [h.id, h]));
  const missing = [...new Set(lines.map((g) => g.grn_id))].filter((id) => !heads.has(id));
  for (const h of await readIn<GrnHead>(sb, 'grns', headCols, 'id', missing, companyId)) heads.set(h.id, h);

  const splits = await readIn<{ grn_item_id: string; rack_id: string; qty: number | null }>(
    sb, 'grn_item_racks', 'grn_item_id, rack_id, qty', 'grn_item_id', lines.map((g) => g.id), companyId);
  const splitsByLine = new Map<string, Array<{ rack_id: string; qty: number }>>();
  for (const s of splits) {
    (splitsByLine.get(s.grn_item_id) ?? splitsByLine.set(s.grn_item_id, []).get(s.grn_item_id)!).push({ rack_id: s.rack_id, qty: Number(s.qty ?? 0) });
  }
  const rackIds = [...new Set([...lines.map((g) => g.rack_id), ...splits.map((s) => s.rack_id)].filter((x): x is string => !!x))];
  if (rackIds.length === 0) return [];
  /* warehouse_racks has no company_id: the boundary is the warehouse, which the
     caller resolved under the DO's company (the same boundary do-line-racks keeps). */
  const racks = await readIn<{ id: string; rack: string | null; warehouse_id: string | null }>(
    sb, 'warehouse_racks', 'id, rack, warehouse_id', 'warehouse_id', [...whs], null,
    (q) => pgrestIn(q, 'id', rackIds));
  const rackById = new Map(racks.map((r) => [r.id, r]));

  const out: GrnRackRow[] = [];
  for (const g of lines) {
    const head = heads.get(g.grn_id);
    if (!head || head.status !== 'POSTED') continue;
    const poId = (g.purchase_order_item_id ? poIdByPoItem.get(g.purchase_order_item_id) : null) ?? head.purchase_order_id;
    const po = poId ? poNoById.get(poId) : null;
    if (!po) continue;
    const placed = splitsByLine.get(g.id) ?? (g.rack_id ? [{ rack_id: g.rack_id, qty: Number(g.qty_accepted ?? 0) }] : []);
    for (const p of placed) {
      const rack = rackById.get(p.rack_id);
      if (!rack?.warehouse_id || !(p.qty > 0)) continue;
      if (head.warehouse_id && head.warehouse_id !== rack.warehouse_id) continue;
      out.push({
        po, grn: head.grn_number ?? head.id, grn_at: head.received_at ?? '', item_code: g.item_code as string,
        variant_key: computeVariantKey(g.item_group ?? null, g.variants ?? null),
        warehouse_id: rack.warehouse_id, rack_id: p.rack_id, label: rack.rack, qty: p.qty,
      });
    }
  }
  return out;
}
