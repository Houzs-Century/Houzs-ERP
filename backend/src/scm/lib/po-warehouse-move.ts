/* A PO's new ship-to warehouse takes its lines with it (sister fix Conts-ERP #783).
 *
 * The GRN made from the outstanding-lines picker receives into each LINE's
 * warehouse while the GRN made from the PO uses the header's, so a header-only
 * change sent the same PO's goods to two warehouses depending on the button.
 *
 * Called by the header PATCH (routes/mfg-purchase-orders.ts) BEFORE it writes
 * the header: if the header write then fails, a retry still sees the old header
 * warehouse, finds nothing left on it, and just saves the header.
 *   - lines still on the OLD header warehouse move to the new one;
 *   - a line deliberately set to another warehouse keeps it, and a line with no
 *     warehouse already follows the header;
 *   - a line with goods already received is never moved: the change is refused
 *     and says why. A live GRN is refused earlier by the identity lock
 *     (shared/po-identity-lock.ts); this covers received_qty left without one.
 * Reads and writes carry the company predicate (scopeToCompanyId). */
import { scopeToCompanyId } from './companyScope';

type Refusal = { status: 409 | 500; body: Record<string, unknown> };

export async function movePoLinesToNewWarehouse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST-shaped client the route holds has no static type for the SCM tables
  sb: any,
  poId: string,
  companyId: number,
  before: Record<string, unknown>,
  updates: Record<string, unknown>,
): Promise<Refusal | null> {
  const oldWh = (before.purchase_location_id as string | null) ?? null;
  if (updates.purchase_location_id === undefined) return null;
  const newWh = (updates.purchase_location_id as string | null) || null;
  if (!newWh || !oldWh || newWh === oldWh) return null;

  const { data, error } = await scopeToCompanyId(sb.from('purchase_order_items')
    .select('id, item_code, warehouse_id, received_qty').eq('purchase_order_id', poId), companyId);
  if (error) return { status: 500, body: { error: 'load_failed', reason: error.message } };
  const onOld = ((data ?? []) as Array<{ id: string; item_code: string | null; warehouse_id: string | null; received_qty: number | null }>)
    .filter((l) => l.warehouse_id === oldWh);
  const received = onOld.filter((l) => Number(l.received_qty ?? 0) > 0);
  if (received.length > 0) {
    return {
      status: 409,
      body: {
        error: 'po_lines_received',
        message: `Goods were already received on ${received.map((l) => l.item_code ?? l.id).join(', ')} into the current warehouse, `
          + 'so the ship-to warehouse cannot be changed. Receive the rest as it is, or move the received stock with a stock transfer.',
        lines: received.map((l) => ({ id: l.id, itemCode: l.item_code })),
      },
    };
  }
  if (onOld.length === 0) return null;
  const { error: upErr } = await scopeToCompanyId(sb.from('purchase_order_items')
    .update({ warehouse_id: newWh }).in('id', onOld.map((l) => l.id)), companyId);
  if (upErr) {
    return { status: 500, body: { error: 'update_failed', message: 'The PO lines could not be moved to the new warehouse, so nothing was saved. Try again.', reason: upErr.message } };
  }
  return null;
}
