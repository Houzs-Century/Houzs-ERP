import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MrpResponse } from '../../vendor/scm/lib/mrp-queries';

let mrpData: MrpResponse;
let canWriteScmConfig = false;

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: () => ({ data: mrpData, isLoading: false, isError: false, error: null, refetch: () => {} }),
  useCategoryLeadTimes: () => ({ data: { categories: [], leadTimes: {} }, isLoading: false }),
  useUpdateCategoryLeadTime: () => ({ mutate: () => {}, isPending: false }),
  useRegenerateMrp: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/auth', () => ({
  useAuth: () => ({ staff: { role: 'sales' }, canWriteScmConfig }),
  isAdminLevel: () => false,
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useCreatePosFromSoItems: () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false }),
}));

import { Mrp } from './Mrp';

const base = (): MrpResponse => ({
  asOf: '2026-09-21T00:00:00Z',
  categories: ['SOFA'], warehouses: [], skus: [], sofaSets: [],
  undated: { lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true },
  totals: { skuCount: 0, shortageSkuCount: 0, shortageUnits: 0, sofaSetCount: 0, sofaSetShortageCount: 0 },
});

const leadTimesButton = () => screen.queryByRole('button', { name: /lead times/i });

afterEach(() => { canWriteScmConfig = false; });

describe('MRP toolbar — Lead Times gates on SCM config-write, not admin', () => {
  test('a config-write user (Purchaser / Operation) sees the Lead Times button', () => {
    mrpData = base();
    canWriteScmConfig = true;
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    expect(leadTimesButton()).not.toBeNull();
  });

  test('a user without config-write does not see the Lead Times button', () => {
    mrpData = base();
    canWriteScmConfig = false;
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    expect(leadTimesButton()).toBeNull();
  });
});
