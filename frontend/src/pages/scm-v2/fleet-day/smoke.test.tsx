/* Render smoke tests for the remaining Last Mile board components. They mount
   inside the real providers with empty/null inputs, which (a) proves each file
   renders without crashing and (b) keeps every module executed by a test so the
   frontend coverage ratchet's zero-coverage-files floor does not rise. */
import { describe, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotifyProvider } from '../../../vendor/scm/components/NotifyDialog';
import { FleetDayStats } from './Stats';
import { FleetDayFilterRow } from './FilterRow';
import { AllOrdersTab } from './AllOrders';
import { HistoryTab } from './History';
import { ToArrangeTab } from './ToArrange';
import { OrderDrawer } from './OrderDrawer';
import { CrewModal } from './CrewModal';
import { EMPTY_FILTERS } from './vm';
import type { DayStats } from '../../../vendor/scm/lib/fleet-day-cards';

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NotifyProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </NotifyProvider>
    </QueryClientProvider>,
  );
}

const ZERO_STATS: DayStats = { lorries: 0, drops: 0, delivered: 0, onTheWay: 0, late: 0, totalSen: 0, withPod: 0, podRatePct: null };

describe('Last Mile board — render smoke', () => {
  test('stat strip mounts', () => {
    const { getByText } = wrap(<FleetDayStats stats={ZERO_STATS} />);
    expect(getByText('Lorries')).toBeTruthy();
  });

  test('filter row mounts', () => {
    const { getByText } = wrap(
      <FleetDayFilterRow filters={EMPTY_FILTERS} onChange={vi.fn()} regionTabs={[]} salespeople={[]} lateCount={0} />,
    );
    expect(getByText(/Late only/)).toBeTruthy();
  });

  test('all-orders empty state mounts', () => {
    const { getByText } = wrap(<AllOrdersTab rows={[]} onOpen={vi.fn()} />);
    expect(getByText(/No orders match/)).toBeTruthy();
  });

  test('history placeholder mounts', () => {
    const { getByText } = wrap(<HistoryTab />);
    expect(getByText(/Delivery history is coming/)).toBeTruthy();
  });

  test('to-arrange empty state mounts', () => {
    const { getByText } = wrap(
      <ToArrangeTab orders={[]} date="2026-11-01" drivers={[]} helpers={[]} lorries={[]} salespersonOf={() => '—'} onAssigned={vi.fn()} />,
    );
    expect(getByText(/Every order due this day is on a lorry/)).toBeTruthy();
  });

  test('order drawer mounts closed (no doc)', () => {
    const { container } = wrap(<OrderDrawer doc={null} run={null} salespersonName="—" onClose={vi.fn()} />);
    expect(container).toBeTruthy();
  });

  test('crew modal mounts closed (no run)', () => {
    const { container } = wrap(
      <CrewModal run={null} trips={[]} drivers={[]} helpers={[]} lorries={[]} leave={undefined} date="2026-11-01" onClose={vi.fn()} onApplied={vi.fn()} />,
    );
    expect(container).toBeTruthy();
  });
});
