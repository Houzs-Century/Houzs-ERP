import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* AddSupplierBinding reuses the Supplier-side create-binding mutation to bind a
   SKU to a supplier from the product drawer. Mock the data hooks; MoneyInput and
   Button render for real. */
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  suppliers: { isLoading: false, data: [{ id: 'sup-1', code: '400-H004', name: 'HOOKKA' }] },
}));

vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: h.invalidate }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useSuppliers: () => h.suppliers,
  useCreateBinding: () => ({ mutate: h.mutate, isPending: false }),
}));

import { AddSupplierBinding } from './AddSupplierBinding';

describe('AddSupplierBinding', () => {
  beforeEach(() => { h.mutate.mockReset(); h.invalidate.mockReset(); });

  it('opens the form and creates a mfg_product binding for the chosen supplier', () => {
    render(<AddSupplierBinding productCode="ZOFIA-(S)" productName="ZOFIA BEDFRAME" />);
    fireEvent.click(screen.getByText('+ Add supplier binding'));
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'sup-1' } });
    fireEvent.click(screen.getByText('Add'));
    expect(h.mutate).toHaveBeenCalledTimes(1);
    const [payload] = h.mutate.mock.calls[0];
    expect(payload).toMatchObject({
      supplierId: 'sup-1',
      materialKind: 'mfg_product',
      itemCode: 'ZOFIA-(S)',
      supplierSku: 'ZOFIA-(S)', // defaults to our code when left blank
    });
  });

  it('refuses to submit without a supplier and shows why', () => {
    render(<AddSupplierBinding productCode="X" productName="Y" />);
    fireEvent.click(screen.getByText('+ Add supplier binding'));
    fireEvent.click(screen.getByText('Add'));
    expect(h.mutate).not.toHaveBeenCalled();
    expect(screen.getByText('Pick a supplier.')).toBeTruthy();
  });
});
