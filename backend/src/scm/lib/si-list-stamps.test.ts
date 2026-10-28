// si-list-stamps was lifted out of routes/sales-invoices.ts on 2026-08-23 and
// landed with no test executing it — with grn-audit-meta, the pair that pushed
// scm/lib's no-test count from 10 to 12 and turned the coverage ratchet red on
// main. What the two stamps promise: ONE batched read per page however many
// rows repeat a key, rows mutated in place, and a failed read that degrades to
// null display columns instead of a 500 on the invoice list.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stampDoNumber, stampSoDates } from './si-list-stamps';

type Store = {
  orders: Array<Record<string, unknown>>;
  dos: Array<Record<string, unknown>>;
  fail: 'mfg_sales_orders' | 'delivery_orders' | null;
  reads: Array<{ table: string; in: unknown[] }>;
};

/** Chainable PostgREST stand-in for the `.in()` batched reads. */
function fakeSb(store: Store) {
  return {
    from: (table: string) => ({
      select: () => ({
        in: async (_col: string, vals: unknown[]) => {
          store.reads.push({ table, in: vals });
          if (store.fail === table) return { data: null, error: { message: `${table} blip` } };
          const src = table === 'mfg_sales_orders' ? store.orders : store.dos;
          return { data: src.filter((r) => vals.includes(r.doc_no ?? r.id)), error: null };
        },
      }),
    }),
  };
}

const store = (over: Partial<Store> = {}): Store => ({
  orders: [{ doc_no: 'HC-SO-2608-001', processing_date: '2026-09-01', customer_delivery_date: '2026-09-03' }],
  dos: [{ id: 'do-1', do_number: 'HC-DO-2608-007' }],
  fail: null,
  reads: [],
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('stampSoDates', () => {
  test('one deduped batched read stamps both dates onto the rows that share the SO', async () => {
    const s = store();
    const rows = [
      { invoice_number: 'SI-1', so_doc_no: 'HC-SO-2608-001' },
      { invoice_number: 'SI-2', so_doc_no: 'HC-SO-2608-001' },
      { invoice_number: 'SI-3', so_doc_no: null },
    ];
    await stampSoDates(fakeSb(s), rows);
    expect(s.reads).toEqual([{ table: 'mfg_sales_orders', in: ['HC-SO-2608-001'] }]);
    expect(rows[0]).toMatchObject({ so_processing_date: '2026-09-01', so_customer_delivery_date: '2026-09-03' });
    expect(rows[1]).toMatchObject({ so_processing_date: '2026-09-01', so_customer_delivery_date: '2026-09-03' });
    expect(rows[2]).toMatchObject({ so_processing_date: null, so_customer_delivery_date: null });
  });

  test('a failed read logs and degrades to null dates instead of throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [{ invoice_number: 'SI-1', so_doc_no: 'HC-SO-2608-001' }];
    await stampSoDates(fakeSb(store({ fail: 'mfg_sales_orders' })), rows);
    expect(rows[0]).toMatchObject({ so_processing_date: null, so_customer_delivery_date: null });
    expect(err).toHaveBeenCalledOnce();
  });

  test('a page with no linked SOs issues no read at all', async () => {
    const s = store();
    await stampSoDates(fakeSb(s), [{ invoice_number: 'SI-1', so_doc_no: null }]);
    await stampSoDates(fakeSb(s), []);
    await stampSoDates(fakeSb(s), 'not-an-array');
    expect(s.reads).toEqual([]);
  });
});

describe('stampDoNumber', () => {
  test('resolves the source DO uuid to its readable number, unknown ids to null', async () => {
    const s = store();
    const rows = [
      { invoice_number: 'SI-1', delivery_order_id: 'do-1' },
      { invoice_number: 'SI-2', delivery_order_id: 'do-unknown' },
      { invoice_number: 'SI-3', delivery_order_id: null },
    ];
    await stampDoNumber(fakeSb(s), rows);
    expect(s.reads).toEqual([{ table: 'delivery_orders', in: ['do-1', 'do-unknown'] }]);
    expect(rows.map((r) => (r as Record<string, unknown>).do_number)).toEqual(['HC-DO-2608-007', null, null]);
  });

  test('a failed read logs and leaves every do_number null instead of throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [{ invoice_number: 'SI-1', delivery_order_id: 'do-1' }];
    await stampDoNumber(fakeSb(store({ fail: 'delivery_orders' })), rows);
    expect(rows[0]).toMatchObject({ do_number: null });
    expect(err).toHaveBeenCalledOnce();
  });
});
