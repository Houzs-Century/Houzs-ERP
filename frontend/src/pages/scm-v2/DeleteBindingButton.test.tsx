import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    fireEvent.click(screen.getByLabelText('Remove HOOKKA'));
    expect(h.mutate).not.toHaveBeenCalled();
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
    expect(screen.getByLabelText('Remove HOOKKA')).toBeTruthy();
  });

  it("surfaces the server's refusal when the binding has been used on a PO", () => {
    h.mutate.mockImplementation((_vars: unknown, opts: { onError?: (e: Error) => void }) =>
      opts.onError?.(new Error("This supplier binding has been used on a purchase order, so it can't be removed.")));
    render(<DeleteBindingButton supplierId="sup-1" bindingId="bind-9" supplierName="HOOKKA" />);
    fireEvent.click(screen.getByLabelText('Remove HOOKKA'));
    fireEvent.click(screen.getByText('Remove'));
    expect(screen.getByRole('alert').textContent).toContain("can't be removed");
  });
});
