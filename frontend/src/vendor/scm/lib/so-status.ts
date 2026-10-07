// Vendored VERBATIM from apps/backend/src/lib/so-status.ts — pure display
// helper (no imports, no supabase). Drives the SO list + detail status pill.

export type DeliveryState = 'none' | 'partial' | 'full';
export type SoLifecycle = 'none' | 'delivered' | 'invoiced' | 'returned';

/* Exported so the CO note gate (co-note-gate.ts) reads this ONE set instead of re-listing it. */
export const TERMINAL: ReadonlySet<string> = new Set(['CANCELLED', 'CLOSED', 'ON_HOLD']);

export type SoStatusDisplay = {
  label: string | null;
  classKey: string;
};

export function soStatusDisplay(
  status: string,
  deliveryState: DeliveryState | undefined,
  lifecycleState?: SoLifecycle,
): SoStatusDisplay {
  if (TERMINAL.has(status)) return { label: null, classKey: status };

  switch (lifecycleState) {
    case 'returned':
      return { label: 'Delivery Return', classKey: 'RETURNED' };
    case 'invoiced':
      return { label: 'Invoiced', classKey: 'INVOICED' };
    case 'delivered':
      if (deliveryState === 'partial') return { label: 'Partially Delivered', classKey: 'SHIPPED' };
      return { label: 'Delivered', classKey: 'DELIVERED' };
    default:
      break;
  }

  if (deliveryState === 'partial') return { label: 'Partially Delivered', classKey: 'SHIPPED' };
  if (deliveryState === 'full') return { label: 'Delivered', classKey: 'DELIVERED' };

  return { label: null, classKey: status };
}
