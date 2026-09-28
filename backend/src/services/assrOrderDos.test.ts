// attachOrderDeliveryDates — the Customer card's DO No + Delivery Date. The DO
// numbers come from attachDeliveryOrders; this pins where each one's DATE comes
// from (SCM delivered_at > do_date, else the AutoCount mirror's doc_date), that
// SCM reads stay inside the case's company, and that the case's own do_date
// (the SERVICE delivery leg) is never used.
import { describe, expect, test, vi } from 'vitest';

type Row = Record<string, unknown>;

const scmRows: Row[] = [
  { do_number: 'HC-DO-2609-244', do_date: '2026-09-26', delivered_at: null, company_id: 1 },
  { do_number: 'HC-DO-2609-300', do_date: '2026-09-20', delivered_at: '2026-09-22T03:00:00+00:00', company_id: 1 },
  // Same number in the OTHER company: must never date a Houzs case.
  { do_number: 'DO-2609-001', do_date: '2025-01-01', delivered_at: null, company_id: 2 },
];

vi.mock('../db/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabaseService: () => ({
    from: () => {
      let rows = [...scmRows];
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => { rows = rows.filter((r) => r[col] === v); return q; },
        in: (col: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[col])); return q; },
        then: <T,>(f: (v: { data: Row[]; error: null }) => T) => Promise.resolve({ data: rows, error: null }).then(f),
      };
      return q;
    },
  }),
}));

const { attachOrderDeliveryDates, orderDoNumbers } = await import('./assrOrderDos');

function env(mirror: Row[]) {
  return {
    DB: {
      prepare: () => ({
        bind: (...nos: unknown[]) => ({
          all: async () => ({ results: mirror.filter((m) => nos.includes(m.doc_no)) }),
        }),
      }),
    },
  } as never;
}

describe('attachOrderDeliveryDates', () => {
  test('SCM DO: delivered_at wins over do_date; never the case do_date', async () => {
    const rows: Row[] = [
      { company_id: 1, do_numbers: 'HC-DO-2609-244', do_date: '2026-10-05' },
      { company_id: 1, do_numbers: 'HC-DO-2609-300' },
    ];
    await attachOrderDeliveryDates(env([]), rows);
    expect(rows[0].order_dos).toEqual([{ do_number: 'HC-DO-2609-244', delivery_date: '2026-09-26' }]);
    expect(rows[1].order_dos).toEqual([{ do_number: 'HC-DO-2609-300', delivery_date: '2026-09-22' }]);
  });

  test('AutoCount-mirror DO dated by doc_date; hand-entered DO wins over do_numbers', async () => {
    const rows: Row[] = [{ company_id: 1, delivery_order: 'DO-000041', do_numbers: 'HC-DO-2609-244' }];
    await attachOrderDeliveryDates(env([{ doc_no: 'DO-000041', doc_date: '2023-09-18' }]), rows);
    expect(rows[0].order_dos).toEqual([{ do_number: 'DO-000041', delivery_date: '2023-09-18' }]);
  });

  test('SCM read is company-scoped: a 2990 number does not date a Houzs case', async () => {
    const rows: Row[] = [{ company_id: 1, do_numbers: 'DO-2609-001' }];
    await attachOrderDeliveryDates(env([]), rows);
    expect(rows[0].order_dos).toEqual([{ do_number: 'DO-2609-001', delivery_date: null }]);
  });

  test('splits the " · " joined list and dedupes', () => {
    expect(orderDoNumbers({ do_numbers: 'A · B · A' })).toEqual(['A', 'B']);
    expect(orderDoNumbers({})).toEqual([]);
  });
});
