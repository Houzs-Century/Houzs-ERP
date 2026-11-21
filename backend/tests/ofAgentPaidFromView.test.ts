/* THE FULFILMENT AGENT READS WHAT AN ORDER HAS BEEN PAID FROM THE SO LIST'S VIEW.
 *
 * patrolOrderFulfilment read scm.mfg_sales_orders.paid_sen, which the ERP writes as 0 on every order it creates
 * (only the AutoCount import ever filled it), so the release gate misread what was paid. It now reads paid_total_sen
 * from scm.mfg_sales_orders_with_payment_totals (the payments ledger), the figure the SO list shows. The agent writes
 * advisory findings only; no order changes.
 */
import { describe, expect, test } from 'vitest';
import { patrolOrderFulfilment } from '../src/services/agents/of-agent';

type Row = Record<string, unknown>;

function fakeDb(onSelect: (sql: string) => Row[]) {
  const seen: string[] = [];
  const db = {
    prepare(sql: string) {
      seen.push(sql);
      const stmt = {
        bind: () => stmt,
        all: async () => ({ results: onSelect(sql) }),
        run: async () => ({ success: true }),
        first: async () => null,
      };
      return stmt;
    },
  };
  return { db, seen };
}

describe('the fulfilment agent paid figure', () => {
  test('the pipeline read takes paid from the view, not the stored header column', async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM scm\.mfg_sales_orders(_with_payment_totals)?\s+WHERE status IN/.test(sql)) {
        return [{
          doc_no: 'SO-1', status: 'CONFIRMED', on_hold: false, debtor_name: 'A', email: 'a@x', address1: '1 Road',
          postcode: '50000', customer_delivery_date: '2026-12-01', local_total_sen: 100000, paid_sen: 100000,
        }];
      }
      return [];
    });
    const r = await patrolOrderFulfilment({ DB: db } as never);
    expect(r.pipeline).toBe(1);
    const soRead = seen.find((s) => /WHERE status IN/.test(s) && /debtor_name/.test(s)) ?? '';
    expect(soRead).toMatch(/FROM scm\.mfg_sales_orders_with_payment_totals\b/);
    expect(soRead).toMatch(/paid_total_sen AS paid_sen/);
  });
});
