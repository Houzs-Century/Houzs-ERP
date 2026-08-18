// The daily cashup's decisions: buckets follow the drawer (cash / transfer /
// per-acquirer), imported rows are never part of a day's takings, a short
// drawer books the loss THE DAY it happened, an over drawer books the reverse,
// zero difference books nothing, and confirming twice books once.

import { describe, it, expect } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { bucketPayments, systemTakings, postCashOverShort } from './daily-close';
import { DEFAULT_ROLE_CODES } from './rules';

const CHART: Row[] = ['335-0000', '946-0000'].map((code) => ({
  account_code: code, account_name: code, account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: 1,
}));

describe('bucketPayments — the drawer view', () => {
  it('cash and transfer are their own buckets; card money groups by acquirer; imported never counts', () => {
    const buckets = bucketPayments([
      { method: 'cash', merchant_provider: null, amount_sen: 100 },
      { method: 'cash', merchant_provider: null, amount_sen: 50 },
      { method: 'transfer', merchant_provider: null, amount_sen: 200 },
      { method: 'merchant', merchant_provider: 'MBB', amount_sen: 300 },
      { method: 'installment', merchant_provider: 'MBB', amount_sen: 40 },
      { method: 'merchant', merchant_provider: 'GHL', amount_sen: 7 },
      { method: 'merchant', merchant_provider: null, amount_sen: 9 },
      { method: 'imported', merchant_provider: null, amount_sen: 99999 },
    ]);
    expect(buckets.get('cash')).toBe(150);
    expect(buckets.get('transfer')).toBe(200);
    expect(buckets.get('MBB')).toBe(340);
    expect(buckets.get('GHL')).toBe(7);
    expect(buckets.get('UNMAPPED')).toBe(9);
    expect([...buckets.keys()]).not.toContain('imported');
  });
});

describe('systemTakings — both sales panels, one day, one company', () => {
  it('sums SO and SI payments of the date and fails closed on a read that does not answer', async () => {
    const sb = fakeSb({
      mfg_sales_order_payments: [
        { company_id: 1, paid_at: '2026-08-16T10:00:00', method: 'cash', merchant_provider: null, amount_sen: 100 },
      ],
      sales_invoice_payments: [
        { company_id: 1, paid_at: '2026-08-16T12:00:00', method: 'cash', merchant_provider: null, amount_sen: 30 },
      ],
    });
    const r = await systemTakings(sb, 1, '2026-08-16');
    expect(r.ok && r.buckets.get('cash')).toBe(130);

    const blip = fakeSb({ mfg_sales_order_payments: [], sales_invoice_payments: [] }, { mfg_sales_order_payments: ['method'] });
    const r2 = await systemTakings(blip, 1, '2026-08-16');
    expect(r2.ok).toBe(false);
  });
});

describe('postCashOverShort — the loss books the day it happened', () => {
  const world = () => fakeSb({ accounts: CHART, acc_account_roles: [], journal_entries: [], journal_entry_lines: [] });

  it('a SHORT drawer: Dr over/short, Cr cash', async () => {
    const sb = world();
    const out = await postCashOverShort(sb, 1, '2026-08-16', -500);
    expect(out).toMatchObject({ ok: true, status: 'posted' });
    const lines = sb.tables.journal_entry_lines;
    expect(lines[0]).toMatchObject({ account_code: DEFAULT_ROLE_CODES.OVER_SHORT, debit_sen: 500 });
    expect(lines[1]).toMatchObject({ account_code: DEFAULT_ROLE_CODES.CASH, credit_sen: 500 });
    expect(sb.tables.journal_entries[0]).toMatchObject({ source_type: 'CASHUP', entry_date: '2026-08-16' });
  });

  it('an OVER drawer books the reverse; zero books nothing; twice books once', async () => {
    const sb = world();
    const over = await postCashOverShort(sb, 1, '2026-08-16', 200);
    expect(over).toMatchObject({ ok: true, status: 'posted' });
    expect(sb.tables.journal_entry_lines[0]).toMatchObject({ account_code: DEFAULT_ROLE_CODES.CASH, debit_sen: 200 });

    const zero = await postCashOverShort(sb, 1, '2026-08-17', 0);
    expect(zero).toMatchObject({ ok: true, status: 'zero_diff' });

    const again = await postCashOverShort(sb, 1, '2026-08-16', 200);
    expect(again).toMatchObject({ ok: true, status: 'already_posted' });
    expect(sb.tables.journal_entries).toHaveLength(1);
  });
});
