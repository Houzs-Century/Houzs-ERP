/* New Stock Take / New Stock Transfer open with today's date filled in. Today
   is the MALAYSIAN day (owner 2026-11-09: every date in the system goes by the
   Malaysian day). Both forms used to read the device's own clock, so between
   00:00 and 08:00 in Malaysia a machine on UTC — or a laptop abroad — filled in
   yesterday. */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 }, can: () => false }) }));
vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>()),
  useInventoryBuckets: () => ({ data: [], isLoading: false }),
  useInventoryBalances: () => ({ data: [], isLoading: false }),
  useCreateStockTransfer: () => ({ isPending: false, mutate: () => undefined }),
  useCreateStockTake: () => ({ isPending: false, mutate: () => undefined, mutateAsync: async () => ({}) }),
}));
vi.mock('../../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({ data: [{ id: 'w1', code: 'WH-A' }, { id: 'w2', code: 'WH-B' }], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/admin-queries')>()),
  usePickableStaff: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => async () => undefined,
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/ConfirmDialog')>()),
  useConfirm: () => async () => true,
}));

import { StockTransferNew } from './StockTransferNew';
import { StockTakeNew } from './StockTakeNew';

const draw = (el: React.ReactElement) => render(
  <MemoryRouter initialEntries={['/x']}><Routes><Route path="/x" element={el} /></Routes></MemoryRouter>,
);


beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 01:30 on 10 November in Malaysia; still the 9th in UTC.
  vi.setSystemTime(new Date('2026-11-09T17:30:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('new stock forms default to the Malaysian day', () => {
  test('New Stock Transfer', () => {
    draw(<StockTransferNew />);
    expect(screen.getAllByDisplayValue('2026/11/10')).toHaveLength(1);
  });

  test('New Stock Take', () => {
    draw(<StockTakeNew />);
    expect(screen.getAllByDisplayValue('2026/11/10')).toHaveLength(1);
  });
});
