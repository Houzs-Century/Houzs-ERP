/* Owner 2026-11-03: scan many delivery orders, check each, then create the drafts; a repeat of a receipt already made starts unticked. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

const review = (doNo: string, poItemId: string | null) => ({ supplierId: 's1', supplierRead: 'DIGLANT', doNo, deliveryDate: '2026-11-03', notes: null, lines: [{ key: `k-${doNo}`, poItemId, qty: 1, read: null }] });
const pending = {
  success: true,
  data: {
    documents: [
      { id: 'a', batchId: 'b', fileName: 'do.pdf', pages: [1, 1], state: 'pending', note: null, review: review('DO-1', 'pi-1'), createdAt: '', hasFile: true, canGold: true, gold: false, duplicateOf: null, blocked: null },
      { id: 'b', batchId: 'b', fileName: 'do.pdf', pages: [2, 2], state: 'pending', note: null, review: review('DO-2', 'pi-2'), createdAt: '', hasFile: true, canGold: true, gold: false, duplicateOf: 'HC-GRN-9', blocked: null },
      { id: 'c', batchId: 'b', fileName: 'do.pdf', pages: [3, 3], state: 'reading', note: null, review: null, createdAt: '', hasFile: true, canGold: true, gold: false, duplicateOf: null, blocked: null },
    ],
    suppliers: [{ id: 's1', code: 'DG', name: 'DIGLANT' }],
    poLines: [
      { poItemId: 'pi-1', poNumber: 'HC-PO-1', supplierId: 's1', itemCode: 'A1', name: null, remaining: 2, warehouse: 'KL' },
      { poItemId: 'pi-2', poNumber: 'HC-PO-2', supplierId: 's1', itemCode: 'A2', name: null, remaining: 2, warehouse: 'KL' },
    ],
  },
};
const create = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, ok: true, grnNumbers: [`HC-GRN-${id}`] })));
vi.mock('../lib/scan-gr-check', async (orig) => ({
  ...(await orig<typeof import('../lib/scan-gr-check')>()),
  fetchPending: vi.fn(async () => pending),
  createFromScans: (ids: string[]) => create(ids),
  saveReview: vi.fn(async () => ({})),
  discardScans: vi.fn(async () => ({})),
}));
const { ScanGrnModal } = await import('./ScanGrnModal');

const mount = () => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><ScanGrnModal onClose={() => {}} /></MemoryRouter></QueryClientProvider>);

describe('ScanGrnModal', () => {
  it('comes back to the waiting list, flags the repeat and leaves it unticked', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Already HC-GRN-9')).toBeTruthy());
    expect(screen.getByText(/2 delivery orders to check · 1 still reading/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create 1 goods receipt as DRAFT/ })).toBeTruthy();
  });
  it('ticking the repeat creates it too, and the result names the drafts', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Already HC-GRN-9')).toBeTruthy());
    fireEvent.click(screen.getAllByLabelText('Include this delivery order')[1]);
    fireEvent.click(screen.getByRole('button', { name: /Create 2 goods receipts as DRAFT/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(['a', 'b']));
    await waitFor(() => expect(screen.getByText(/HC-GRN-a, HC-GRN-b/)).toBeTruthy());
  });
});
