/* Owner 2026-11-04: supplier invoices scanned like delivery orders: check each, then create; an invoice already billed starts unticked. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { billSkuOptions, grnOptions, piBlock, priceDiffers, type BillLine, type PiCheckDoc, type PiReview } from '../lib/scan-pi-check';

const bl = (grnItemId: string, grnNumber: string, itemCode: string, remaining = 2): BillLine => ({ grnItemId, grnNumber, supplierSku: null, supplierId: 's1', poNumber: 'HC-PO-1', itemCode, description: `${itemCode} desc`, remaining, unitPriceSen: 100_00 });
const billLines = [bl('g1', 'HC-GRN-1', 'A1'), bl('g2', 'HC-GRN-2', 'A2')];
const review = (invoiceNumber: string, grnItemId: string): PiReview => ({ v: 1, supplierId: 's1', supplierRead: 'DIGLANT', invoiceNumber, invoiceDate: '2026-11-03', doNo: null, poNo: null, notes: null, lines: [{ key: `k${invoiceNumber}`, grnItemId, grnNumber: null, qty: 1, suggested: false, read: { itemCode: 'T1', description: 'Mattress', qty: 1, unitPrice: 120, lineTotal: 120 } }] });
const doc = (id: string, r: PiReview, duplicateOf: PiCheckDoc['duplicateOf']): PiCheckDoc => ({ id, batchId: 'b', fileName: 'inv.pdf', pages: null, state: 'pending', note: null, review: r, createdAt: '', hasFile: true, canGold: true, gold: false, duplicateOf, repeatOf: null, blocked: null });
const pending = { documents: [doc('a', review('INV-1', 'g1'), null), doc('b', review('INV-2', 'g2'), { id: 'p9', invoiceNumber: 'HC-PI-9', status: 'DRAFT', invoiceDate: null })], suppliers: [{ id: 's1', code: 'DG', name: 'DIGLANT' }], billLines };
const create = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, ok: true, docNumbers: [`HC-PI-${id}`] })));
vi.mock('../lib/scan-pi-check', async (orig) => ({
  ...(await orig<typeof import('../lib/scan-pi-check')>()),
  fetchPiPending: vi.fn(async () => pending),
  createPiFromScans: (ids: string[]) => create(ids),
  savePiReview: vi.fn(async () => ({})),
}));
const { ScanInvoiceModal } = await import('./ScanInvoiceModal');
const mount = () => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><ScanInvoiceModal onClose={() => {}} /></MemoryRouter></QueryClientProvider>);

describe('ScanInvoiceModal', () => {
  it('flags an invoice already billed and leaves it unticked; ticking it creates it too', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Already billed')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Create 1 purchase invoice as draft/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    fireEvent.click(screen.getByRole('button', { name: /Create 2 purchase invoices as draft/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(['a', 'b']));
    await waitFor(() => expect(screen.getByText(/HC-PI-a, HC-PI-b/)).toBeTruthy());
  });
  it('a row marks a supplier price that differs from ours', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByLabelText('Show the lines').length).toBe(2));
    fireEvent.click(screen.getAllByLabelText('Show the lines')[0]);
    expect(screen.getByText('PI Price')).toBeTruthy();
    expect(document.querySelector('.priceOff, [class*="priceOff"]')).toBeTruthy();
  });
});

describe('the invoice row dropdowns', () => {
  it('a GRN narrows the SKUs to what is left to bill on it', () => {
    expect(billSkuOptions(billLines, 'HC-GRN-2').map((o) => o.value)).toEqual(['g2']);
    expect(billSkuOptions(billLines, null).map((o) => o.value)).toEqual(['g1', 'g2']);
    expect(grnOptions([...billLines, billLines[0]]).map((o) => o.value)).toEqual(['HC-GRN-1', 'HC-GRN-2']);
  });
  it('blocks a row billing more than is left', () => {
    const r = review('X', 'g1');
    const m = new Map(billLines.map((l) => [l.grnItemId, l]));
    expect(piBlock({ ...r, lines: [{ ...r.lines[0], qty: 3 }] }, m)).toMatch(/3 is more than the 2 left to bill/);
    expect(piBlock(r, m)).toBeNull();
  });
  it('a price differs by a sen or more', () => {
    expect(priceDiffers(120, 120_00)).toBe(false);
    expect(priceDiffers(120.01, 120_00)).toBe(true);
    expect(priceDiffers(null, 120_00)).toBe(false);
  });
});
