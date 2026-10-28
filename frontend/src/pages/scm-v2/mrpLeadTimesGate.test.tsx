// MRP toolbar — the "Lead Times" config dialog gates on canWriteScmConfig (the
// position-driven "may write SCM master data" answer), NOT on isAdmin.
//
// Symptom: a Purchaser (position policy canWriteConfig=true, no '*' wildcard)
// could not see the Lead Times button, so they could not set the per-category
// order-N-days-early values their OWN Proceed PO consumes.
// Cause: the button was gated on isAdminLevel(staff.role), which the Houzs auth
// bridge only ever satisfies for a '*' wildcard holder (Owner / IT Admin).
// Fix: gate it on canWriteScmConfig, exactly as SO Maintenance gates its writes.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MrpResponse } from '../../vendor/scm/lib/mrp-queries';

let mrpData: MrpResponse;
let canWriteScmConfig = false;

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: () => ({ data: mrpData, isLoading: false, isError: false, error: null, refetch: () => {} }),
  useCategoryLeadTimes: () => ({ data: { leadTimes: {} }, isLoading: false }),
  useUpdateCategoryLeadTime: () => ({ mutate: () => {}, isPending: false }),
  useRegenerateMrp: () => ({ mutate: () => {}, isPending: false }),
}));
// isAdminLevel is pinned FALSE so the tests prove the button shows on the
// config-write answer ALONE — the old admin gate must no longer be involved.
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
