/* One scanned delivery order in the check step: edit the rows before it becomes a draft. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CheckDoc, GrnReview } from '../lib/scan-gr-check';

const search = vi.hoisted(() => vi.fn());
vi.mock('../lib/scan-gr-check', async (orig) => ({ ...(await orig<typeof import('../lib/scan-gr-check')>()), searchProducts: search }));
const { ScanGrnCheckCard } = await import('./ScanGrnCheckCard');
const { localBlock } = await import('../lib/scan-gr-check');

const review: GrnReview = { supplierId: 's1', supplierRead: 'DIGLANT', doNo: 'DO-1', deliveryDate: '2026-11-03', notes: null, lines: [{ key: 'k1', poItemId: null, gift: null, qty: 2, read: { itemCode: 'T1MA', description: 'Mattress', qty: 2, poNo: null } }] };
const doc = { id: 'a', batchId: 'b', fileName: 'do.pdf', pages: null, state: 'pending', note: null, review, createdAt: '', hasFile: false, canGold: false, gold: false, duplicateOf: null, blocked: null } as CheckDoc;
const poLines = [{ poItemId: 'pi-1', poNumber: 'HC-PO-1', supplierId: 's1', itemCode: 'A1', name: 'Mattress Q', remaining: 1, warehouse: 'KL' }];

describe('ScanGrnCheckCard', () => {
  it('opens to the rows; picking the PO line and adding a row reach the parent', () => {
    const onChange = vi.fn();
    render(<ScanGrnCheckCard doc={doc} review={review} suppliers={[{ id: 's1', code: 'DG', name: 'DIGLANT' }]} poLines={poLines} checked block={null} onToggle={() => {}} onChange={onChange} onDelete={() => {}} onRetry={() => {}} onGold={() => {}} />);
    fireEvent.click(screen.getByLabelText('Open to edit'));
    expect(screen.getByText(/T1MA · Mattress · qty 2/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('PO line for row 1'), { target: { value: 'pi-1' } });
    expect(onChange.mock.calls[0][0].lines[0].poItemId).toBe('pi-1');
    fireEvent.click(screen.getByText('Add line'));
    expect(onChange.mock.calls[1][0].lines).toHaveLength(2);
  });
  it('a row on no PO can be marked a free gift of our product (2026-10-20 rule)', async () => {
    search.mockResolvedValue([{ code: 'PILLOW-1', name: 'Pillow' }]);
    const onChange = vi.fn();
    render(<ScanGrnCheckCard doc={doc} review={review} suppliers={[]} poLines={poLines} checked block={null} onToggle={() => {}} onChange={onChange} onDelete={() => {}} onRetry={() => {}} onGold={() => {}} />);
    fireEvent.click(screen.getByLabelText('Open to edit'));
    fireEvent.click(screen.getByText('Free gift: choose our product'));
    fireEvent.change(screen.getByLabelText('Search our product'), { target: { value: 'pil' } });
    fireEvent.click(await screen.findByText(/PILLOW-1 · Pillow/));
    expect(onChange.mock.calls[0][0].lines[0]).toMatchObject({ poItemId: null, gift: { itemCode: 'PILLOW-1', name: 'Pillow' } });
  });
  it('blocks a row asking for more than the PO still owes', () => {
    const map = new Map(poLines.map((l) => [l.poItemId, l]));
    expect(localBlock({ ...review, lines: [{ ...review.lines[0], poItemId: 'pi-1' }] }, map)).toMatch(/2 is more than the 1 still owed/);
    expect(localBlock(review, map)).toMatch(/Choose the PO line/);
  });
});
