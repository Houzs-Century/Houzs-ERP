import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* DeleteBindingButton removes a supplier binding from the product drawer via the
   existing Supplier-side DELETE hook. Mock the hook + query client; the two-step
   confirm (trash -> Remove/Cancel) renders for real. */
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: h.invalidate }),
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useDeleteBinding: () => ({ mutate: h.mutate, isPending: false }),
}));

import { DeleteBindingButton } from './DeleteBindingButton';

describe('DeleteBindingButton', () => {
  beforeEach(() => { h.mutate.mockReset(); h.invalidate.mockReset(); });

  it('needs a second click to remove, and passes the supplier + binding ids', () => {
    render(<DeleteBindingButton supplierId="sup-1" bindingId="bind-9" supplierName="HOOKKA" />);
    // First click only arms the confirm — nothing is deleted yet.
    fireEvent.click(screen.getByLabelText('Remove HOOKKA'));
    expect(h.mutate).not.toHaveBeenCalled();
    // Confirm.
    fireEvent.click(screen.getByText('Remove'));
    expect(h.mutate).toHaveBeenCalledTimes(1);
    const [payload] = h.mutate.mock.calls[0];
    expect(payload).toEqual({ supplierId: 'sup-1', bindingId: 'bind-9' });
  });

  it('Cancel backs out of the confirm and deletes nothing', () => {
    render(<DeleteBindingButton supplierId="sup-1" bindingId="bind-9" supplierName="HOOKKA" />);
    fireEvent.click(screen.getByLabelText('Remove HOOKKA'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(h.mutate).not.toHaveBeenCalled();
    // Back to the single trash affordance.
    expect(screen.getByLabelText('Remove HOOKKA')).toBeTruthy();
  });
});
