import { describe, expect, it } from 'vitest';
import { siAfterSavePath } from './siAfterSave';

describe('siAfterSavePath', () => {
  it('HC-0127: an invoice raised from a DO returns to that DO', () => {
    expect(siAfterSavePath('si-1', 'do-9', 0, null)).toBe('/scm/delivery-orders/do-9');
  });

  it('a failed payment still lands on the invoice to retry, even from a DO', () => {
    expect(siAfterSavePath('si-1', 'do-9', 1, null)).toBe('/scm/sales-invoices/si-1?retryPayments=1');
  });

  it('a plain invoice opens the invoice', () => {
    expect(siAfterSavePath('si-1', null, 0, null)).toBe('/scm/sales-invoices/si-1');
  });
});

describe('siAfterSavePath from a sales order', () => {
  it('HC-0127: an invoice raised from a sales order returns to that SO', () => {
    expect(siAfterSavePath('si-1', null, 0, '/scm/sales-orders/SO-1')).toBe('/scm/sales-orders/SO-1');
  });
});
