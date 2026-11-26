
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
