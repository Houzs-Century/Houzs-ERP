import type { CompanyScopeCtx } from './companyScope';
import { companyScope, type ScopedDb } from './scopedDb';

/** A transfer line's optional racks, as the create body sends them. */
export type LineRacks = { fromRackId: string | null; toRackId: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read `fromRackId` / `toRackId` off one body line. Blank = no rack. Throws on a value that is not a rack id. */
export function readLineRacks(it: Record<string, unknown>): LineRacks {
  const pick = (key: 'fromRackId' | 'toRackId'): string | null => {
    const raw = it[key];
    if (raw === undefined || raw === null || raw === '') return null;
    const v = String(raw).trim();
    if (!UUID_RE.test(v)) throw new Error(`${key} is not a rack id`);
    return v;
  };
  return { fromRackId: pick('fromRackId'), toRackId: pick('toRackId') };
}

/** One rack that holds less of an item than the transfer takes off it. */
export type RackShortage = { rackId: string; itemCode: string; requested: number; held: number };

/**
 * Pure: per (From rack, item) the transfer's total qty against what the rack holds.
 * `held` is keyed `rackId::itemCode`. Lines without a From rack are not checked.
 */
export function rackShortages(
  lines: ReadonlyArray<{ item_code: string; qty: number; fromRackId: string | null }>,
  held: ReadonlyMap<string, number>,
): RackShortage[] {
  const want = new Map<string, { rackId: string; itemCode: string; qty: number }>();
  for (const l of lines) {
    if (!l.fromRackId || l.qty <= 0) continue;
    const k = `${l.fromRackId}::${l.item_code}`;
    const cur = want.get(k) ?? { rackId: l.fromRackId, itemCode: l.item_code, qty: 0 };
    cur.qty += l.qty;
    want.set(k, cur);
  }
  const out: RackShortage[] = [];
  for (const [k, w] of want) {
    const h = held.get(k) ?? 0;
    if (w.qty > h) out.push({ rackId: w.rackId, itemCode: w.itemCode, requested: w.qty, held: h });
  }
  return out;
}

export type RackCheckRefusal = { status: 400 | 409 | 503; body: { error: string; message: string } };

/**
 * Before anything is written: every named rack must be a rack of this company in the
 * right warehouse, and every From rack must hold enough. The database function checks
 * the same again inside the transaction, so a race still cannot over-take a rack.
 */
export async function checkTransferRacks(
  db: ScopedDb,
  c: CompanyScopeCtx,
  fromWarehouseId: string,
  toWarehouseId: string,
  lines: ReadonlyArray<{ item_code: string; qty: number } & LineRacks>,
): Promise<RackCheckRefusal | null> {
  const ids = [...new Set(lines.flatMap((l) => [l.fromRackId, l.toRackId]).filter((x): x is string => !!x))];
  if (ids.length === 0) return null;

  const { data: racks, error: rackErr } = await db
    .from('warehouse_racks', companyScope(c)).select('id, rack, warehouse_id').in('id', ids);
  if (rackErr) return { status: 503, body: { error: 'rack_check_failed', message: `Could not read the racks: ${rackErr.message}` } };
  const byId = new Map((racks as Array<{ id: string; rack: string; warehouse_id: string }>).map((r) => [r.id, r]));

  for (const l of lines) {
    if (l.fromRackId && byId.get(l.fromRackId)?.warehouse_id !== fromWarehouseId) {
      return { status: 400, body: { error: 'rack_not_in_warehouse', message: `${l.item_code}: the From rack is not a rack of the From warehouse.` } };
    }
    if (l.toRackId && byId.get(l.toRackId)?.warehouse_id !== toWarehouseId) {
      return { status: 400, body: { error: 'rack_not_in_warehouse', message: `${l.item_code}: the To rack is not a rack of the To warehouse.` } };
    }
  }

  const fromIds = [...new Set(lines.map((l) => l.fromRackId).filter((x): x is string => !!x))];
  if (fromIds.length === 0) return null;
  const codes = [...new Set(lines.filter((l) => l.fromRackId).map((l) => l.item_code))];
  const { data: items, error: itemErr } = await db
    .from('warehouse_rack_items', companyScope(c)).select('rack_id, item_code, qty')
    .in('rack_id', fromIds).in('item_code', codes);
  if (itemErr) return { status: 503, body: { error: 'rack_check_failed', message: `Could not read what the racks hold: ${itemErr.message}` } };
  const held = new Map<string, number>();
  for (const r of items as Array<{ rack_id: string; item_code: string; qty: number }>) {
    const k = `${r.rack_id}::${r.item_code}`;
    held.set(k, (held.get(k) ?? 0) + Number(r.qty));
  }
  const short = rackShortages(lines, held);
  if (short.length === 0) return null;
  const message = short
    .map((s) => `${byId.get(s.rackId)?.rack ?? 'rack'} holds only ${s.held} of ${s.itemCode}, the transfer takes ${s.requested}`)
    .join('; ');
  return { status: 409, body: { error: 'rack_short', message } };
}
