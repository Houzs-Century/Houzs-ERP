/* The phone's "Collected on <SO>" card on a delivery order — desktop parity
   with DeliveryOrderDetailV2's aside card, over the same component and the same
   query, so the two surfaces cannot start disagreeing about money.

   Its own file for two reasons. MobileModuleDetail renders EIGHT module kinds
   from one component, and a hook called inline there would fire on all eight —
   a payments read on every purchase order and goods receipt opened on a phone.
   And that file sits within twenty lines of the 2,000-line cap, so anything
   that can live outside it should.

   Read-only on both surfaces: the sales order is the one place a payment is
   taken, and a second entry point for the same receipt is the same money
   counted twice. */

import { useSalesOrderPayments } from '../vendor/scm/lib/sales-order-queries';
import { CollectedOnOrderCard } from '../vendor/scm/components/CollectedOnOrderCard';

export function MobileCollectedOnOrder({
  soDocNo,
  currency,
}: {
  soDocNo: string;
  currency: string;
}) {
  const q = useSalesOrderPayments(soDocNo);
  return (
    <div style={{ padding: '0 12px 12px' }}>
      <CollectedOnOrderCard
        soDocNo={soDocNo}
        payments={q.data}
        error={q.error}
        isLoading={q.isLoading}
        currency={currency}
      />
    </div>
  );
}
