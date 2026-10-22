/* What the supplier page sends on Save (owner 2026-09-30: 采购只看采购的部分;
   代码只有 finance 能改). Pinned: a purchaser's save carries no Finance field —
   not even the blanks the old full-form save sent back — and the code rides
   only when it changed; Finance's save carries everything. */
import { describe, expect, it } from 'vitest';
import { supplierSaveBody } from './supplier-save-body';
import { SUPPLIER_FINANCE_BODY_KEYS } from '../../shared/supplier-finance-fields';

const form = {
  code: '400-A004', name: 'ARMANI SOFA SDN. BHD.', paymentTerms: 'Net 30', currency: 'MYR',
  tinNumber: '', businessRegNo: '', registrationNo: '', exemptionNo: '', contactPerson: 'Ah Kow',
};

describe('supplierSaveBody', () => {
  it('a purchaser sends the purchasing part only, and no code while it is unchanged', () => {
    const body = supplierSaveBody(form, '400-A004', false);
    for (const k of SUPPLIER_FINANCE_BODY_KEYS) expect(body).not.toHaveProperty(k);
    expect(body).not.toHaveProperty('code');
    expect(body).toMatchObject({ name: 'ARMANI SOFA SDN. BHD.', paymentTerms: 'Net 30', currency: 'MYR', contactPerson: 'Ah Kow' });
  });

  it('Finance sends every field', () => {
    const body = supplierSaveBody({ ...form, tinNumber: 'C123' }, '400-A004', true);
    expect(body).toMatchObject({ tinNumber: 'C123', businessRegNo: '', registrationNo: '', exemptionNo: '' });
    expect(body).not.toHaveProperty('code');
  });

  it('a changed code rides, trimmed — the server decides whether it may change', () => {
    expect(supplierSaveBody({ ...form, code: ' 405-A004 ' }, '400-A004', true)).toMatchObject({ code: '405-A004' });
    expect(supplierSaveBody({ ...form, code: '405-A004' }, '400-A004', false)).toMatchObject({ code: '405-A004' });
    expect(supplierSaveBody({ ...form, code: ' 400-A004 ' }, '400-A004', false)).not.toHaveProperty('code');
  });
});
