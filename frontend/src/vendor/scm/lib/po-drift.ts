// When a PO's source SO changed after the PO was raised (items[].so_drift), what
// the screen should say depends on where the order is (owner 2026-11-09):
//   actionable  with the supplier: sync the specs and re-send;
//   received    the goods came in to the PO's spec: check them before delivery;
//   null        draft / cancelled: nothing was ordered, so nothing is stale.
// Desktop (PurchaseOrderDetail) and phone (MobileModuleDetail) share this gate.
export type PoDriftMode = 'actionable' | 'received' | null;

export function poDriftMode(status: string | null): PoDriftMode {
  const st = (status ?? '').toUpperCase();
  if (st === 'SUBMITTED' || st === 'PARTIALLY_RECEIVED') return 'actionable';
  if (st === 'RECEIVED') return 'received';
  return null;
}
