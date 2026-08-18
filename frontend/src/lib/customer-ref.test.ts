import { describe, expect, test } from 'vitest';

import { customerRefOf } from './customer-ref';

describe('customerRefOf — one order-reference rule for every relationship map', () => {
  test('customer_so_no leads — it is the filled value in production', () => {
    expect(customerRefOf({ customer_so_no: 'HC11430', po_doc_no: 'PO-9', ref: 'X' })).toBe('HC11430');
  });

  test('falls back to po_doc_no then ref only when customer_so_no is absent', () => {
    expect(customerRefOf({ customer_so_no: null, po_doc_no: 'PO-9' })).toBe('PO-9');
    expect(customerRefOf({ customer_so_no: '', po_doc_no: '', ref: 'R-1' })).toBe('R-1');
  });

  test('empty when nothing is recorded', () => {
    expect(customerRefOf({})).toBe('');
    expect(customerRefOf(null)).toBe('');
    expect(customerRefOf(undefined)).toBe('');
  });

  test('trims whitespace', () => {
    expect(customerRefOf({ customer_so_no: '  HC11430  ' })).toBe('HC11430');
  });

  /* THE REGRESSION. The four builders used three different fallback orders, so a
     header carrying BOTH customer_so_no and po_doc_no resolved differently on
     the DO map (po_doc_no first) than the SI map (customer_so_no first). With
     one helper the answer is identical whatever order the fields are read in. */
  test('a header with BOTH customer_so_no and po_doc_no resolves to ONE value everywhere', () => {
    const header = { customer_so_no: 'HC11430', po_doc_no: 'LEGACY-PO' };
    // whatever surface builds it, the reference is the same
    expect(customerRefOf(header)).toBe('HC11430');
    expect(customerRefOf(header)).not.toBe('LEGACY-PO');
  });
});
