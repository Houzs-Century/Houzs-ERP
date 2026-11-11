/* The Delivery Planning board's per-leg status for a Service Case (owner 2026-11-06):
   a dropdown — Delivered / Cancelled / — (pending). Delivered stamps the leg's
   actual_* date (the leg shows Delivered on the Delivered tab); Cancelled stamps
   cancelled_* and the leg DROPS off the board; both are leg-only and NEVER close
   the case (closure stays a separate ASSR-module action). Every change is recorded
   on the case. n/a for SO / DP / project rows (they derive their own state).

   Its own module (not inline in DeliveryPlanningBoard.tsx) to keep that file under
   its size ceiling. */
import type { PlanningOrder, useScheduleDelivery } from '../lib/delivery-planning-queries';

export type MarkDeliveredSchedule = ReturnType<typeof useScheduleDelivery>['mutate'];

export function MarkDeliveredCell({ order, onSchedule }: { order: PlanningOrder; onSchedule: MarkDeliveredSchedule }) {
  if (order.row_type !== 'assr') return <span style={{ color: 'var(--hz-c-ink-muted)' }}>—</span>;
  // A cancelled leg is already off the board, so a visible row is only pending or delivered.
  const value: 'delivered' | 'pending' = order.delivery_state === 'DELIVERED' ? 'delivered' : 'pending';
  return (
    <select
      aria-label="Leg status"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => onSchedule({
        type: 'assr', id: String(order.assr_id ?? ''), jobKind: order.job_kind,
        assrLegStatus: e.target.value as 'delivered' | 'cancelled' | 'pending',
      })}
      style={{ width: '100%', fontSize: 12, padding: '3px 6px', border: '1px solid var(--line, #d1d5db)', borderRadius: 6, background: 'var(--c-paper, var(--hz-c-surface))', color: 'var(--c-ink, #30332b)' }}
    >
      <option value="pending">—</option>
      <option value="delivered">Delivered</option>
      <option value="cancelled">Cancelled</option>
    </select>
  );
}
