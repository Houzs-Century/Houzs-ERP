/* The East Malaysia touchpoints (owner 2026-11-20): each kind shows its own
   title and operator note. Shipped / Arrived read the shipment facts off the
   board's EM columns server-side, so the modal only explains that; nothing is
   typed here. */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import type { PlanningOrder, SendMessageKind } from '../lib/delivery-planning-queries';

vi.mock('../lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../lib/dialog-service', () => ({ serviceNotify: vi.fn() }));
const { SendDeliveryMessageModal } = await import('./SendDeliveryMessageModal');
const { NotifyProvider } = await import('./NotifyDialog');

const emRow: PlanningOrder = {
  row_type: 'so', so_doc_no: 'HC-SO-099001', phone: '+60 88-123456',
  debtor_name: 'Kuching Customer', branding: 'AKEMI', customer_delivery_date: '2026-12-01',
  amended_delivery_date: null, balance_sen: 0, balance_sen_live: 0, regions: ['EM'], region: 'EM',
} as unknown as PlanningOrder;

const renderWith = (kind: SendMessageKind) => {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NotifyProvider>
        <SendDeliveryMessageModal rows={[emRow]} kind={kind} onClose={vi.fn()} onSent={vi.fn()} />
      </NotifyProvider>
    </QueryClientProvider>,
  );
};

describe('SendDeliveryMessageModal — East Malaysia touchpoints', () => {
  test('prep notice: its title and the confirm-details note', () => {
    renderWith('eastmy_prep');
    expect(screen.getByText('Send East Malaysia prep notice')).toBeTruthy();
    expect(screen.getByText(/confirm the final delivery details/i)).toBeTruthy();
  });

  test('shipped: title and the "reads Consignment + ETA off the row" note', () => {
    renderWith('eastmy_shipped');
    expect(screen.getByText('Send East Malaysia shipped notice')).toBeTruthy();
    expect(screen.getByText(/Consignment No\./)).toBeTruthy();
    expect(screen.getByText(/ETA \(arriving port\)/)).toBeTruthy();
  });

  test('arrived: title and the warehouse-arrival-date note', () => {
    renderWith('eastmy_arrived');
    expect(screen.getByText('Send East Malaysia arrived notice')).toBeTruthy();
    expect(screen.getByText(/EM-warehouse arrival date/)).toBeTruthy();
  });
});
