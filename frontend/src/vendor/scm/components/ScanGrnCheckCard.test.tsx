/* The check step after the owner's design pass (2026-11-04): each thing shown once, PO and SKU as dropdowns, free gifts from the same SKU list. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { isOddDate, localBlock, poOptions, shortNote, skuOptions, swappedDate, type CheckDoc, type GrnReview } from '../lib/scan-gr-check';

vi.mock('../lib/scan-gr-check', async (orig) => ({
  ...(await orig<typeof import('../lib/scan-gr-check')>()),
  fetchSupplierSkus: vi.fn(async () => [{ code: 'A1', name: 'Mattress Q' }, { code: 'PILLOW-1', name: 'Pillow' }]),
}));
const { ScanGrnCheckCard } = await import('./ScanGrnCheckCard');

const line = { key: 'k1', poItemId: null, poNumber: null, gift: null, qty: 2, rack: 'R11-2', suggested: false, read: { itemCode: 'T1MA', description: 'Mattress', qty: 2, poNo: null } };
const review: GrnReview = { v: 2, supplierId: 's1', supplierRead: 'DIGLANT', doNo: 'DO-1', deliveryDate: '2026-11-03', notes: null, lines: [line] };
const doc = { id: 'a', batchId: 'b', fileName: 'do.pdf', pages: null, state: 'pending', note: null, review, createdAt: '', hasFile: false, canGold: false, gold: false, duplicateOf: null, repeatOf: null, blocked: null } as CheckDoc;
const poLines = [
  { poItemId: 'pi-1', poNumber: 'HC-PO-1', supplierId: 's1', supplierSku: null, itemCode: 'A1', name: 'Mattress Q', remaining: 1, warehouse: 'KL' },
  { poItemId: 'pi-2', poNumber: 'HC-PO-2', supplierId: 's1', supplierSku: null, itemCode: 'A2', name: 'Mattress K', remaining: 3, warehouse: 'PG' },
];
const mount = (over: Partial<CheckDoc> = {}, onChange = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ScanGrnCheckCard doc={{ ...doc, ...over }} review={review} suppliers={[{ id: 's1', code: 'DG', name: 'DIGLANT' }]} poLines={poLines} checked block={null}
        onToggle={() => {}} onChange={onChange} onDelete={() => {}} onRetry={() => {}} onGold={() => {}} onOpenGrn={() => {}} />
    </QueryClientProvider>,
  );
  return onChange;
};

describe('ScanGrnCheckCard', () => {
  it('the head row is the fields: D.O. no edits in place, and nothing repeats below', async () => {
    const onChange = mount();
    fireEvent.change(screen.getByLabelText('Delivery order number'), { target: { value: 'DO-2' } });
    expect(onChange.mock.calls[0][0].doNo).toBe('DO-2');
    fireEvent.click(screen.getByLabelText('Show the lines'));
    await waitFor(() => expect(screen.getByText(/Printed: T1MA · Mattress/)).toBeTruthy());
    expect(screen.getAllByLabelText('Delivery order number')).toHaveLength(1);
    expect((screen.getByLabelText('Rack for row 1') as HTMLInputElement).value).toBe('R11-2');
  });
  it('a D.O. already received says where, and can still be created', () => {
    const onOpen = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ScanGrnCheckCard doc={{ ...doc, duplicateOf: { id: 'g9', grnNumber: 'HC-GRN-9', status: 'DRAFT', receivedAt: '2026-11-02T00:00:00Z' } }} review={review} suppliers={[]} poLines={poLines} checked={false} block={null}
          onToggle={() => {}} onChange={() => {}} onDelete={() => {}} onRetry={() => {}} onGold={() => {}} onOpenGrn={onOpen} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Already received')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create anyway' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'HC-GRN-9' }));
    expect(onOpen).toHaveBeenCalledWith('g9');
  });
});

describe('the row dropdowns', () => {
  const skus = [{ code: 'A1', name: 'Mattress Q' }, { code: 'PILLOW-1', name: 'Pillow' }];
  it('a PO narrows the SKUs to what is still owed on it', () => {
    expect(skuOptions(poLines, skus, 'HC-PO-2', line).map((o) => o.value)).toEqual(['line:pi-2']);
  });
  it('no PO: everything owed, then the other SKUs of the supplier as free gifts', () => {
    const o = skuOptions(poLines, skus, null, line);
    expect(o.map((x) => x.value)).toEqual(['line:pi-1', 'line:pi-2', 'gift:PILLOW-1']);
    expect(o[2].group).toMatch(/free gift/);
  });
  it('lists each open PO once', () => {
    expect(poOptions([...poLines, poLines[0]]).map((o) => o.value)).toEqual(['HC-PO-1', 'HC-PO-2']);
  });
  it('blocks a row asking for more than the PO still owes', () => {
    const map = new Map(poLines.map((l) => [l.poItemId, l]));
    expect(localBlock({ ...review, lines: [{ ...line, poItemId: 'pi-1' }] }, map)).toMatch(/2 is more than the 1 still owed/);
  });
  it('offers the swap only when it lands near today (DGSN26002448)', () => {
    expect(swappedDate('2026-03-11', '2026-11-04')).toBe('2026-11-03');
    expect(swappedDate('2026-11-03', '2026-11-04')).toBeNull();
    expect(swappedDate('2026-03-20', '2026-11-04')).toBeNull();
  });
  it('a matcher note is cut to its reason; a PO number with dots or a D.O. does not end it early', () => {
    expect(shortNote('We read P.O. HC-1 (D.O. DG2), but PO HC-1 is marked Received, so no receipt was created. Please check.'))
      .toBe('We read P.O. HC-1 (D.O. DG2), but PO HC-1 is marked Received, so no receipt was created.');
  });
  it('a date months away is flagged, a recent one is not', () => {
    expect(isOddDate('2026-03-11', '2026-11-04')).toBe(true);
    expect(isOddDate('2026-11-03', '2026-11-04')).toBe(false);
    expect(isOddDate(null, '2026-11-04')).toBe(false);
  });
});
