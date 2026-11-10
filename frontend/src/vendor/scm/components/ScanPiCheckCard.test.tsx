/* HOOKKA INV-2610-097 (owner 2026-11-10): a row printed at RM 0 stays untied and says why; PO Amount is the paid rows only. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScanPiCheckCard } from './ScanPiCheckCard';
import { FREE_ROW_NOTE, type BillLine, type PiCheckDoc, type PiReview, type PiReviewLine } from '../lib/scan-pi-check';

const line = (grnItemId: string, itemCode: string, unitPriceSen: number): BillLine => ({ grnItemId, grnNumber: 'HC-GRN-2611-033', supplierSku: null, supplierId: 's1', poNumber: 'HC-PO-2610-210', itemCode, description: itemCode, remaining: 1, unitPriceSen });
const billLines = [line('jager', 'JAGER-(Q)', 440_00), line('sofa', '5536-1NA', 550_00)];
const row = (key: string, grnItemId: string | null, description: string, price: number): PiReviewLine => ({ key, grnItemId, grnNumber: null, qty: 1, suggested: false, read: { itemCode: null, description, qty: 1, unitPrice: price, lineTotal: price } });
const review: PiReview = {
  v: 6, supplierId: 's1', supplierRead: 'HOOKKA', invoiceNumber: 'INV-2610-097', invoiceDate: '2026-10-30', doNo: 'DO-2610-090',
  poNo: 'EX-PO-009744, EX-HC-PO-2609-151, EX-HC-PO-2609-226', notes: null, taxNote: null, lineTier: 'whole_receipt',
  lines: [row('1', null, 'JAGER BEDFRAME 5FT', 0), row('2', null, 'CODY BEDFRAME 3FT', 0), row('3', null, 'CODY BEDFRAME 3FT', 0), row('4', 'sofa', 'SOFA 5536 1NA', 550)],
};
const doc: PiCheckDoc = { id: 'd', batchId: null, fileName: 'inv.pdf', pages: null, state: 'pending', note: null, review, createdAt: '', hasFile: false, canGold: false, gold: false, duplicateOf: null, repeatOf: null, blocked: null };
const noop = () => {};

describe('ScanPiCheckCard, free rows', () => {
  it('shows PO Amount for the sofa only, the exchange banner, and why each free row is untied', () => {
    render(<ScanPiCheckCard doc={doc} review={review} suppliers={[{ id: 's1', code: 'HK', name: 'HOOKKA' }]} billLines={billLines} checked block={null} onToggle={noop} onChange={noop} onDelete={noop} onRetry={noop} onGold={noop} onOpenPi={noop} />);
    expect(screen.getByText(/^PO Amount/).textContent).toMatch(/550\.00/);
    expect(screen.getByText(/^PO Amount/).textContent).not.toMatch(/not matched/);
    expect(screen.getByText(/marks PO-009744, HC-PO-2609-151, HC-PO-2609-226 as exchange/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show the lines' }));
    expect(screen.getAllByText(FREE_ROW_NOTE)).toHaveLength(3);
  });
});
