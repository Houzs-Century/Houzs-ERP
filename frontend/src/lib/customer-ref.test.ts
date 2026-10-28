import { describe, expect, test } from 'vitest';

import { customerRefOf } from './customer-ref';

describe('customerRefOf — one order-reference rule for every relationship map', () => {
  test('ref leads — the owner ruled it is the correct customer-reference field', () => {
    expect(customerRefOf({ ref: 'HC11430', customer_so_no: 'X', po_doc_no: 'PO-9' })).toBe('HC11430');
  });

  test('falls back to customer_so_no then po_doc_no only when ref is absent', () => {
    expect(customerRefOf({ ref: null, customer_so_no: 'HC11430' })).toBe('HC11430');
    expect(customerRefOf({ ref: '', customer_so_no: '', po_doc_no: 'PO-9' })).toBe('PO-9');
  });

  test('empty when nothing is recorded', () => {
    expect(customerRefOf({})).toBe('');
    expect(customerRefOf(null)).toBe('');
    expect(customerRefOf(undefined)).toBe('');
  });

  test('trims whitespace', () => {
    expect(customerRefOf({ ref: '  HC11430  ' })).toBe('HC11430');
  });

  /* THE REGRESSION. The four builders used three different fallback orders, so a
     header carrying BOTH customer_so_no and po_doc_no resolved differently on
     the DO map (po_doc_no first) than the SI map (customer_so_no first). With
     one helper the answer is identical whatever order the fields are read in. */
  test('a header with ref AND the legacy columns resolves to ONE value everywhere', () => {
    const header = { ref: 'HC11430', customer_so_no: 'SRC-SO', po_doc_no: 'LEGACY-PO' };
    // whatever surface builds it, the reference is the same
    expect(customerRefOf(header)).toBe('HC11430');
    expect(customerRefOf(header)).not.toBe('LEGACY-PO');
    expect(customerRefOf(header)).not.toBe('SRC-SO');
  });
});
