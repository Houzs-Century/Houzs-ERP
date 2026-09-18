/* The SO side of a Customer Refund (§14): the refunds raised on the order,
   linked by number; nothing at all when there are none. */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

let source: Record<string, unknown> | undefined;
let isError = false;
vi.mock('../lib/payment-voucher-queries', () => ({
  useRefundSource: () => ({ data: source ? { source } : undefined, isError, isLoading: false }),
}));

import { RefundsLine } from './RefundsLine';

describe('RefundsLine', () => {
  test('lists every refund voucher on the order with its number and the total, flagging the unapproved', () => {
    source = {
      refunds: [
        { id: 'pv-a', pvNumber: '2990-MRF-2609-001', status: 'POSTED', voucherDate: '2026-09-07', totalSen: 30000 },
        { id: 'pv-b', pvNumber: '2990-Draft-2609-004', status: 'DRAFT', voucherDate: '2026-09-07', totalSen: 5000 },
      ],
    };
    render(<RefundsLine docNo="2990-SO-2607-001" />);
    expect(screen.getByText('Refunded RM 350.00')).toBeTruthy();
    expect(screen.getByText('(1 not yet approved)')).toBeTruthy();
    expect(screen.getByText('2990-MRF-2609-001 · RM 300.00').closest('a')!.getAttribute('href')).toBe('/scm/payment-vouchers/pv-a');
    expect(screen.getByText('2990-Draft-2609-004 · RM 50.00 (draft)')).toBeTruthy();
  });

  test('renders nothing when there is no refund, and nothing on a failed read', () => {
    source = { refunds: [] };
    const { container, unmount } = render(<RefundsLine docNo="2990-SO-2607-002" />);
    expect(container.innerHTML).toBe('');
    unmount();
    source = undefined; isError = true;
    const second = render(<RefundsLine docNo="2990-SO-2607-003" />);
    expect(second.container.innerHTML).toBe('');
  });
});
