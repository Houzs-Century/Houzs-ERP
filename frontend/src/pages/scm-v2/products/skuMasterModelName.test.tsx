/* 2990-0022: after a model rename the SKU Master Model column shows the new
 * name (base_model is still the old code, e.g. 8210) and the filter offers it. */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { MfgProductRow } from '../../../vendor/scm/lib/mfg-products-queries';

const sofa = (id: string, code: string, base_model: string, model_name: string): MfgProductRow => ({
  id, code, name: `SOFA ${code}`, category: 'SOFA',
  base_price_sen: 100000, price1_sen: null, status: 'ACTIVE', unit_m3_milli: 0,
  base_model, model_name, model_id: `model-${base_model}`,
});
const ROWS = [sofa('a', '8210-3S', '8210', 'TANNAH'), sofa('b', '5530-3S', '5530', 'CROWN')];

const idle = { mutate: () => {}, mutateAsync: async () => ({}), isPending: false };
vi.mock('../../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: ROWS, isLoading: false, isFetching: false, error: null }),
  useMaintenanceConfig: () => ({ data: undefined, isLoading: false }),
  useMfgProductSuppliers: () => ({ data: { suppliers: [], anchor: null }, isLoading: false }),
  useUpdateMfgProductPrices: () => idle,
  useDeleteMfgProduct: () => idle,
  useUpdateMfgProductStatus: () => idle,
}));
vi.mock('../../../vendor/scm/lib/product-models-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/product-models-queries')>()),
  useBrandingPool: () => ({ pool: [] }),
  useProductModel: () => ({ data: undefined }),
}));

import { Products } from '../Products';
import { NotifyProvider } from '../../../vendor/scm/components/NotifyDialog';
import { ConfirmProvider } from '../../../vendor/scm/components/ConfirmDialog';

describe('SKU Master Model column follows a model rename', () => {
  test('the Sofa view shows the model name, not the old base_model code', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
        <NotifyProvider><ConfirmProvider><MemoryRouter><Products /></MemoryRouter></ConfirmProvider></NotifyProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sofa' }));
    expect(screen.getByText('TANNAH')).toBeTruthy();
    expect(screen.getByText('CROWN')).toBeTruthy();
    expect(screen.queryByText('8210')).toBeNull();
    expect(screen.getByLabelText('Model filter')).toBeTruthy();
  });
});
