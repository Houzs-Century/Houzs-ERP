/* BUG-31 follow-up: the SKU drawer's "Belongs to model" line printed the SKU's
 * base_model, which is blank on a 1:1 model (CROWN (SS+S) after the Modular
 * backfill), so it read "Belongs to model —". It names the model from the
 * model's own row now. */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { MfgProductRow } from '../../../vendor/scm/lib/mfg-products-queries';

const CROWN: MfgProductRow = {
  id: 'mfg-crown', code: 'CROWN (SS+S)', name: 'CROWN (SS+S) BEDFRAME', category: 'BEDFRAME',
  base_price_sen: 72000, price1_sen: null, status: 'ACTIVE', unit_m3_milli: 0,
  base_model: null, model_id: 'model-crown-ssps',
};

const idle = { mutate: () => {}, mutateAsync: async () => ({}), isPending: false };
vi.mock('../../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [CROWN], isLoading: false, isFetching: false, error: null }),
  useMaintenanceConfig: () => ({ data: undefined, isLoading: false }),
  useMfgProductSuppliers: () => ({ data: { suppliers: [], anchor: null }, isLoading: false }),
  useUpdateMfgProductPrices: () => idle,
  useDeleteMfgProduct: () => idle,
  useUpdateMfgProductStatus: () => idle,
}));
vi.mock('../../../vendor/scm/lib/product-models-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/product-models-queries')>()),
  useBrandingPool: () => ({ pool: [] }),
  useProductModel: (id: string | undefined) => ({
    data: id === 'model-crown-ssps' ? { model: { id, model_code: 'CROWN (SS+S)' }, skus: [] } : undefined,
  }),
}));

import { Products } from '../Products';
import { NotifyProvider } from '../../../vendor/scm/components/NotifyDialog';
import { ConfirmProvider } from '../../../vendor/scm/components/ConfirmDialog';

describe('SKU drawer names the model the SKU belongs to', () => {
  test('a 1:1 model with no base_model still shows its model code', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
        <NotifyProvider><ConfirmProvider><MemoryRouter><Products /></MemoryRouter></ConfirmProvider></NotifyProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View suppliers for CROWN (SS+S)' }));
    expect(screen.getByText(/Belongs to model CROWN \(SS\+S\) —/)).toBeTruthy();
  });
});
