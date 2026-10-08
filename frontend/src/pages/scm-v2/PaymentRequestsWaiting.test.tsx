/* The Payment Vouchers page's reminder (owner 2026-10-08: 在payment voucher 会有
   一个接口for payment request, 就类似提醒我有几个payment request 还没proceed).
   Pinned: the count says how many wait for Finance, in both languages; one
   press lands on Payment Requests filtered to 「Waiting for Finance」; at 0 —
   and for anyone but Finance, whose count is 0 — nothing shows. */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

let waiting = 3;
vi.mock('../../hooks/useAmendmentApprovals', () => ({ usePaymentRequestsWaiting: () => waiting }));

const { PaymentRequestsWaiting } = await import('./PaymentRequestsWaiting');

function Landed() {
  const loc = useLocation();
  return <div aria-label="landed">{`${loc.pathname}${loc.search}`}</div>;
}
const draw = () => render(
  <MemoryRouter initialEntries={['/scm/payment-vouchers']}>
    <Routes>
      <Route path="/scm/payment-vouchers" element={<PaymentRequestsWaiting />} />
      <Route path="/scm/payment-requests" element={<Landed />} />
    </Routes>
  </MemoryRouter>,
);

describe('the waiting-requests reminder', () => {
  test('says how many wait, and one press opens them filtered to Waiting for Finance', () => {
    waiting = 3;
    draw();
    const banner = screen.getByRole('status', { name: 'Payment requests waiting for Finance' });
    expect(banner.textContent).toContain('3 payment requests waiting for Finance · 3 张申请付款等你处理');
    fireEvent.click(screen.getByRole('button', { name: 'Open them · 去处理' }));
    expect(screen.getByLabelText('landed').textContent).toBe('/scm/payment-requests?filter=waiting');
  });

  test('one request reads in the singular; none shows nothing', () => {
    waiting = 1;
    const { unmount } = draw();
    expect(screen.getByRole('status').textContent).toContain('1 payment request waiting for Finance');
    unmount();
    waiting = 0;
    const { container } = draw();
    expect(container.textContent).toBe('');
  });
});
