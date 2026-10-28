/**
 * The header's round back button must land on the Product Models list. It used
 * to be history-back, and opening the list's detail drawer changes no URL, so
 * history-back left Product Models for whatever page came before it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProductModelDetail } from './ProductModelDetail';

// Hook results must be stable references: the page's seeding effect depends on
// them, and a fresh object per render loops it forever.
const STABLE = vi.hoisted(() => ({
  model: {
    data: {
      model: {
        id: 'M1', model_code: 'JAGER', name: 'Jager Bedframe', category: 'BEDFRAME',
        active: true, photo_url: null, branding: null, description: null, allowed_options: null,
      },
      skus: [],
    },
    isPending: false,
    error: null,
  },
  empty: { data: [] },
}));

vi.mock('../../vendor/scm/lib/product-models-queries', () => {
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useProductModel: () => STABLE.model,
    useUpdateProductModel: mut,
    useDeleteProductModel: mut,
    useGenerateModelSkus: mut,
    useActivateOneShot: mut,
    useUploadProductModelPhoto: mut,
    useBrandingPool: () => ({ pool: [] }),
  };
});
vi.mock('../../vendor/scm/lib/mfg-products-queries', () => ({
  useMaintenanceConfig: () => ({ data: undefined }),
  useUpdateMfgProductStatus: () => ({ mutate: vi.fn(), isPending: false }),
  useSpecialAddons: () => STABLE.empty,
  mfgCategoryLabel: (c: string) => c,
}));
vi.mock('../../vendor/scm/lib/queries', () => ({ useFabricLibrary: () => STABLE.empty }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => async () => true }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));
vi.mock('../../components/DataTable', () => ({ DataTable: () => null }));
vi.mock('../../components/scm-v2/PhotoGallery', () => ({ PhotoGallery: () => null }));
vi.mock('../../vendor/scm/components/CategorySwapSelect', () => ({ CategorySwapSelect: () => null }));

const backButton = () => screen.getByRole('button', { name: 'Back' });

describe('ProductModelDetail back button', () => {
  it('closes the list drawer instead of leaving the page', async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/somewhere-else', '/scm/product-models']} initialIndex={1}>
        <Routes>
          <Route path="/scm/product-models" element={<ProductModelDetail modelId="M1" onClose={onClose} />} />
          <Route path="*" element={<div>WRONG PAGE</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(backButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('WRONG PAGE')).toBeNull();
  });

  it('goes to the Product Models list on the direct /:id route', async () => {
    render(
      <MemoryRouter initialEntries={['/somewhere-else', '/scm/product-models/M1']} initialIndex={1}>
        <Routes>
          <Route path="/scm/product-models/:id" element={<ProductModelDetail />} />
          <Route path="/scm/product-models" element={<div>MODELS LIST</div>} />
          <Route path="*" element={<div>WRONG PAGE</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(backButton());
    expect(await screen.findByText('MODELS LIST')).toBeTruthy();
  });
});
