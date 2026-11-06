/* The To do calendar without supplier bills (owner 2026-11-04: 这些supplier
 * bill 可以remove 先吗？) — an open AP invoice due in the month shows on no
 * day and not in the next 7 days, while a voucher waiting for approval still
 * does.
 */
import { describe, expect, it } from 'vitest';
import { fakeSb } from '../lib/fake-postgrest';
import { readCalendarPage, SUPPLIER_BILLS_ON_CALENDAR } from './accounting-todo-calendar';

const CO = 1;

describe('the To do calendar', () => {
  it('leaves supplier bills out; a voucher on its way still shows', async () => {
    const sb = fakeSb({
      ap_invoices: [{ id: 'api-1', company_id: CO, invoice_number: 'HC-API-2611-001', supplier_id: 'sup-1', status: 'POSTED', due_date: '2026-11-05', total_sen: 50000, paid_sen: 0, exchange_rate: null }],
      purchase_invoices: [],
      suppliers: [{ id: 'sup-1', company_id: CO, name: 'HOOKKA SDN BHD' }],
      payment_vouchers: [{ id: 'pv-1', company_id: CO, pv_number: 'MPV-2611-0001', payee_name: 'MSJ', status: 'DRAFT', submitted_at: '2026-11-03T00:00:00Z', approved_at: null, checked_at: null, voucher_date: '2026-11-05', total_sen: 12000, exchange_rate: null }],
    });
    const page = await readCalendarPage(sb, CO, '2026-11-04', '2026-11', null);

    expect(SUPPLIER_BILLS_ON_CALENDAR).toBe(false);
    expect(page.events.filter((e) => e.key.startsWith('bill:'))).toEqual([]);
    expect(page.problems.some((p) => p.startsWith('supplier bills'))).toBe(false);
    expect(page.events.map((e) => e.key)).toContain('pv:pv-1');
  });
});
