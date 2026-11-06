/* The Delivery Planning board's per-leg "Mark Delivered" for a Service Case
   (owner 2026-11-06: "板上直接标 Delivered"). An SO/DO becomes DELIVERED from its
   POD; a service leg had no board way to be marked done, so Logistics gets a
   toggle here. It writes the leg's actual_* date (type:'assr' + deliveryState)
   and does NOT close the case — closing stays a separate action in the ASSR
   module. The leg then moves to the Delivered tab while the case stays open; its
   other legs are unaffected. n/a for SO / DP / project rows (they derive their
   own state).

   Its own module (not inline in DeliveryPlanningBoard.tsx) to keep that file
   under its size ceiling. */
import { Button } from '../../../components/Button';
import type { PlanningOrder, useScheduleDelivery } from '../lib/delivery-planning-queries';

export type MarkDeliveredSchedule = ReturnType<typeof useScheduleDelivery>['mutate'];

export function MarkDeliveredCell({ order, onSchedule }: { order: PlanningOrder; onSchedule: MarkDeliveredSchedule }) {
  if (order.row_type !== 'assr') return <span style={{ color: '#767b6e' }}>—</span>;
  const delivered = order.delivery_state === 'DELIVERED';
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ display: 'flex', width: '100%' }}
    >
      <Button
        variant="ghost"
        onClick={() => onSchedule({
          type: 'assr', id: String(order.assr_id ?? ''), jobKind: order.job_kind,
          deliveryState: delivered ? 'PENDING_DELIVERY' : 'DELIVERED',
        })}
        title={delivered
          ? 'Marked delivered — click to reopen this leg (does not reopen the case)'
          : 'Mark this leg delivered (records the leg only; does not close the case)'}
      >
        {delivered ? 'Delivered' : 'Mark delivered'}
      </Button>
    </span>
  );
}
