/* Decision 10b (owner 2026-09-29: 先付款，只提醒) — a supplier short of its tax
   identity is paid anyway, and Finance is told what is missing and where. A
   caller who cannot see the Finance part (the keys are absent) is never told. */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

let detail: Record<string, unknown> | undefined;
vi.mock('../lib/suppliers-queries', () => ({
  useSupplierDetail: (id: string | null) => ({ data: id && detail ? { supplier: detail, bindings: [] } : undefined }),
}));

import { SupplierFinanceReminder, missingSupplierFinance } from './SupplierFinanceReminder';

describe('missingSupplierFinance', () => {
  test('TIN and a registration number (either spelling) are what count', () => {
    expect(missingSupplierFinance({ tin_number: null, business_reg_no: null, registration_no: null })).toEqual(['TIN', 'registration no.']);
    expect(missingSupplierFinance({ tin_number: 'C123', business_reg_no: null, registration_no: '202301027399' })).toEqual([]);
    expect(missingSupplierFinance({ tin_number: ' ', business_reg_no: '1234567-X' })).toEqual(['TIN']);
  });

  test('keys the server left out are "not yours to see", not missing', () => {
    expect(missingSupplierFinance({})).toBeNull();
    expect(missingSupplierFinance(null)).toBeNull();
  });
});

describe('SupplierFinanceReminder', () => {
  const draw = () => render(<MemoryRouter><SupplierFinanceReminder supplierId="sup-1" /></MemoryRouter>);

  test('names what is missing and links Supplier Maintenance; the payment is not blocked', () => {
    detail = { id: 'sup-1', name: 'MLE EVENTS SDN BHD', tin_number: null, business_reg_no: null, registration_no: null };
    draw();
    const note = screen.getByRole('status', { name: 'Supplier finance details missing' });
    expect(note.textContent).toContain('MLE EVENTS SDN BHD has no TIN or registration no.');
    expect(note.textContent).toContain('the payment can still go ahead');
    expect(screen.getByText('Supplier Maintenance').getAttribute('href')).toBe('/scm/supplier-maintenance?open=sup-1');
  });

  test('stays quiet for a complete supplier, and for a caller who cannot see the Finance part', () => {
    detail = { id: 'sup-1', name: 'X', tin_number: 'C1', business_reg_no: 'B1', registration_no: null };
    const { unmount } = draw();
    expect(screen.queryByRole('status')).toBeNull();
    unmount();
    detail = { id: 'sup-1', name: 'X' };
    draw();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
