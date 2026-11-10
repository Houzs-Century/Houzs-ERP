/* Duplicate supplier bills — the copies booked before the server refused a
   second one (#5535). Pinned: one row per copy under its supplier + bill, each
   document number links to its own page, what paid each copy sits beside it, a
   bill with money on more than one copy is flagged, and none reads as empty. */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { DuplicateBillGroup } from '../../vendor/scm/lib/ap-invoice-queries';

let groups: DuplicateBillGroup[] = [];
vi.mock('../../vendor/scm/lib/ap-invoice-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/ap-invoice-queries')>()),
  useDuplicateSupplierBills: () => ({ data: { groups }, isLoading: false, isError: false, error: null }),
}));

import { DuplicateSupplierBills } from './DuplicateSupplierBills';

const copy = (id: string, over: Partial<DuplicateBillGroup['copies'][number]> = {}) => ({
  id, invoiceNumber: `HC-PI-2609-00${id}`, supplierInvoiceRef: 'SB-001', invoiceDate: '2026-09-01',
  currency: 'MYR', totalSen: 350_000, paidSen: 0, status: 'POSTED', settlements: [], ...over,
});

describe('Duplicate supplier bills', () => {
  test('each copy links to its own page with what paid it, and a bill paid twice is flagged', () => {
    groups = [{
      kind: 'PI', docKind: 'INV', supplierId: 'sup-a', supplierCode: '400-A001', supplierName: 'ALPHA', billKey: 'SB-001', paidMoreThanOnce: true,
      copies: [
        copy('1', { paidSen: 350_000, settlements: [{ kind: 'PV', id: 'pv-1', number: 'HC-PV-2609-001', status: 'POSTED', amountSen: 350_000 }] }),
        copy('2', { paidSen: 350_000, settlements: [{ kind: 'CN', id: 'n-1', number: 'HC-SCN-2609-001', status: 'POSTED', amountSen: 350_000 }] }),
      ],
    }];
    render(<MemoryRouter><DuplicateSupplierBills /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'HC-PI-2609-001' }).getAttribute('href')).toBe('/scm/purchase-invoices/1');
    expect(screen.getByRole('link', { name: 'HC-PI-2609-002' }).getAttribute('href')).toBe('/scm/purchase-invoices/2');
    expect(screen.getByRole('link', { name: 'HC-PV-2609-001' }).getAttribute('href')).toBe('/scm/payment-vouchers/pv-1');
    expect(screen.getByText('HC-SCN-2609-001')).toBeTruthy();
    expect(screen.getByText('Money on more than one copy')).toBeTruthy();
    expect(screen.getByText('1 of 1 has money on more than one copy.')).toBeTruthy();
  });

  test('an AP bill opens on the AP bill page', () => {
    groups = [{
      kind: 'API', docKind: 'INV', supplierId: 'sup-b', supplierCode: null, supplierName: 'BETA', billKey: 'R7', paidMoreThanOnce: false,
      copies: [copy('a1', { invoiceNumber: 'HCAPI-2609-001' }), copy('a2', { invoiceNumber: 'HCAPI-2609-002' })],
    }];
    render(<MemoryRouter><DuplicateSupplierBills /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'HCAPI-2609-001' }).getAttribute('href')).toBe('/scm/ap-invoices/a1');
    expect(screen.queryByText('Money on more than one copy')).toBeNull();
  });

  test('no duplicates says so', () => {
    groups = [];
    render(<MemoryRouter><DuplicateSupplierBills /></MemoryRouter>);
    expect(screen.getByText('No supplier bill is booked twice.')).toBeTruthy();
  });
});
