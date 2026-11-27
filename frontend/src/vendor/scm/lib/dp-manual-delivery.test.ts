/* Owner 2026-11-20 (option A): a delivery with no sales order can be raised in
   Delivery Planning. It is a create-mode entry for job type DELIVERY, so it never
   carries a so_doc_no (the board's union guard lists only so-less DP jobs), and
   the SO-backed "Delivery order" entry stays schedule-mode. */
import { describe, expect, it } from 'vitest';
import { DP_CREATABLE_JOB_TYPES, DP_ENTRY_MENU, dpTotalAmountSen, salesAmountSenOf } from './delivery-planning-queries';
import { POSTCODE_REQUIRED_JOB_TYPES } from '../../shared/dp-postcode-rule';

describe('Delivery (no SO) in the New DP Order menu', () => {
  it('is a create-mode DELIVERY beside the schedule-mode Delivery order', () => {
    const manual = DP_ENTRY_MENU.find((e) => e.key === 'DELIVERY_MANUAL');
    expect(manual).toMatchObject({ label: 'Delivery (no SO)', mode: 'create', jobType: 'DELIVERY' });
    expect(DP_ENTRY_MENU.find((e) => e.key === 'DELIVERY_ORDER')).toMatchObject({ mode: 'schedule', scheduleType: 'so' });
    expect(DP_CREATABLE_JOB_TYPES).toContain('DELIVERY');
  });
  it('needs a postcode like every delivery', () => {
    expect(POSTCODE_REQUIRED_JOB_TYPES.has('DELIVERY')).toBe(true);
  });
});

describe('the sales amount typed on a Delivery (no SO) (owner 2026-11-20)', () => {
  it('reads RM into sen; blank clears; junk or a negative is not an amount', () => {
    expect(salesAmountSenOf('3500')).toBe(350000);
    expect(salesAmountSenOf('3,500.50')).toBe(350050);
    expect(salesAmountSenOf('  ')).toBeNull();
    expect(salesAmountSenOf('abc')).toBeUndefined();
    expect(salesAmountSenOf('-5')).toBeUndefined();
  });
});

describe('the board Total Amount for a DP row (dpTotalAmountSen)', () => {
  it('reads the source SO total when the job has one', () => {
    expect(dpTotalAmountSen({ so_total_sen: 350000, sales_amount_sen: null })).toBe(350000);
    expect(dpTotalAmountSen({ so_total_sen: 350000, sales_amount_sen: 1 })).toBe(350000);
    expect(dpTotalAmountSen({ so_total_sen: 0, sales_amount_sen: null })).toBe(0);
  });
  it('falls back to a Delivery (no SO) own Sales Amount (owner 2026-11-20, Mr Choo RM1800)', () => {
    expect(dpTotalAmountSen({ so_total_sen: null, sales_amount_sen: 180000 })).toBe(180000);
    expect(dpTotalAmountSen({ so_total_sen: null, sales_amount_sen: '180000' })).toBe(180000);
  });
  it('is null (renders a dash) when the row carries neither amount', () => {
    expect(dpTotalAmountSen({ so_total_sen: null, sales_amount_sen: null })).toBeNull();
    expect(dpTotalAmountSen({ so_total_sen: null, sales_amount_sen: 'abc' })).toBeNull();
  });
});
