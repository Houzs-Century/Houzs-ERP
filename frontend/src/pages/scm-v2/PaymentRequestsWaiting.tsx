// ----------------------------------------------------------------------------
// PaymentRequestsWaiting — the Payment Vouchers page's reminder (owner
// 2026-10-08: 在payment voucher 会有一个接口for payment request, 就类似提醒我有几个
// payment request 还没proceed … 做): how many requests wait for Finance — the
// Payment Requests page's own 「Waiting for Finance」 — and one press to them.
// Nothing at 0, nothing for anyone but Finance (the count is 0 for them). Read
// fresh on arrival; the sidebar badge shares the same count.
// ----------------------------------------------------------------------------

import { useNavigate } from 'react-router-dom';
import { HandCoins } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { usePaymentRequestsWaiting } from '../../hooks/useAmendmentApprovals';

export function PaymentRequestsWaiting() {
  const waiting = usePaymentRequestsWaiting();
  const navigate = useNavigate();
  if (waiting <= 0) return null;
  return (
    <div
      role="status"
      aria-label="Payment requests waiting for Finance"
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap',
        padding: '10px 14px', borderRadius: 10, border: '1px solid var(--c-orange)', background: 'var(--c-paper, #f4f6f3)',
      }}
    >
      <HandCoins size={18} strokeWidth={1.75} aria-hidden="true" style={{ color: 'var(--c-orange)' }} />
      <span style={{ fontWeight: 600, fontSize: 'var(--fs-13)' }}>
        {waiting} payment request{waiting === 1 ? '' : 's'} waiting for Finance · {waiting} 张申请付款等你处理
      </span>
      <span style={{ flex: 1 }} />
      <Button variant="primary" size="sm" onClick={() => navigate('/scm/payment-requests?filter=waiting')}>
        Open them · 去处理
      </Button>
    </div>
  );
}
