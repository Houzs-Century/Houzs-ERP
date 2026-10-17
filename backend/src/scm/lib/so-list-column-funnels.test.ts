// lib/so-list-column-funnels — the value lists the Sales Order grid offers in
// each server-run column funnel: every value across the company's orders, in the
// grid's own cell spelling, never another company's.
import { describe, expect, it } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { buildSoFunnelValues } from './so-list-column-funnels';

type Row = Record<string, unknown>;
const c = { get: (k: string) => (k === 'companyId' ? 1 : undefined) };
const so = (over: Row): Row => ({ doc_no: 'X', company_id: 1, status: 'CONFIRMED', so_date: '2026-09-01', ...over });

async function values(rows: Row[], more: Record<string, Row[]> = {}, canFinance = false) {
  const sb = fakeSb({ mfg_sales_orders_with_payment_totals: rows, mfg_sales_orders: [], staff: [], warehouses: [], ...more });
  const out = await buildSoFunnelValues(sb, c, null, canFinance);
  if (out.error !== null) throw new Error(out.error);
  return out.values;
}

describe('the Sales Order funnel value lists', () => {
  it('lists every value across the company, blanks as an empty value, other companies never', async () => {
    const v = await values([
      so({ doc_no: 'A', city: 'KL', local_total_sen: 1000 }),
      so({ doc_no: 'B', city: null, local_total_sen: 2000, currency: 'USD' }),
      so({ doc_no: 'C', city: 'SECRET', company_id: 2 }),
    ]);
    expect(v.city).toEqual(['', 'KL']);
    expect(v.amount).toEqual(['1000', '2000']);
    expect(v.currency).toEqual(['MYR', 'USD']);
    expect(v.erp_doc_no).toEqual(['A', 'B']);
  });

  it('spells the derived cells as the grid does', async () => {
    const v = await values(
      [
        so({ doc_no: 'A', ref: null, customer_so_no: 'CUST-1', salesperson_id: 'aaaaaaaa-0000-0000-0000-000000000001', agent: null, sales_location: 'Johor Bahru' }),
        so({ doc_no: 'B', ref: null, customer_so_no: null, agent: 'NICO', debtor_code: null }),
      ],
      {
        mfg_sales_orders: [{ doc_no: 'B', company_id: 1, linked_ac_docno: 'SO-AC-1' }],
        staff: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'ALICE TAN' }],
        warehouses: [{ id: 'w1', company_id: 1, code: 'BALAKONG', name: 'x' }, { id: 'w2', company_id: 2, code: 'ELSEWHERE', name: 'y' }],
      },
    );
    expect(v.doc_no).toEqual(['A', 'SO-AC-1']);
    expect(v.reference).toEqual(['CUST-1', '—']);
    expect(v.salesperson).toContain('ALICE TAN');
    expect(v.debtor_code).toContain('300-C002'); // a book order with no code
    expect(v.sales_location).toEqual(['', 'BALAKONG', 'Johor Bahru']);
  });

  it('offers finance column values only to a finance viewer', async () => {
    const rows = [so({ doc_no: 'A', total_cost_sen: 700 })];
    expect((await values(rows)).total_cost_sen).toBeUndefined();
    expect((await values(rows, {}, true)).total_cost_sen).toEqual(['700']);
  });
});
