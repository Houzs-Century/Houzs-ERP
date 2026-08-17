/* The GRN-from-PO read, and the three properties that stop it lying by omission.
 *
 * Owner 2026-08-17: HC-PO-2608-001 showed two lines at Ordered 1 / Received 0 /
 * Balance 1 on the purchase order and `0 OF 0 ROWS` in the picker meant to
 * receive it. The read was `.order('purchase_order_id').limit(500)` with both
 * filters applied afterwards in JS. `purchase_order_id` is a UUID, so that
 * ordering is arbitrary and the 500 was an arbitrary SAMPLE — it hid 168 of
 * company HOUZS's 356 outstanding lines, measured against production.
 *
 * These tests assert the SHAPE OF THE STATEMENT, not just its output, because
 * the bug was invisible in the output: a truncated read and a finished job
 * return the identical empty array. There is no assertion available on "did it
 * return everything" that a `.limit()` would fail — only the query itself says.
 */
import { describe, expect, it } from 'vitest';
import {
  fetchOutstandingPoItems,
  type OutstandingPoItemRow,
  type OutstandingPoItemsClient,
} from './outstanding-po-items';

const OPEN = ['SUBMITTED', 'PARTIALLY_RECEIVED'] as const;

type Call = { method: string; args: unknown[] };

const line = (over: Partial<OutstandingPoItemRow> = {}): OutstandingPoItemRow =>
  ({
    id: 'poi-1', purchase_order_id: 'po-1', material_kind: 'mfg_product',
    material_code: '9028-1A(LHF)', material_name: 'Sofa LHF', supplier_sku: null,
    item_group: 'sofa', description: null, qty: 1, received_qty: 0,
    unit_price_centi: 0, warehouse_id: 'wh-1', variants: null, delivery_date: null,
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
    po: {
      id: 'po-1', po_number: 'HC-PO-2608-001', supplier_id: 'sup-1', status: 'SUBMITTED',
      po_date: '2026-08-17', expected_at: null, purchase_location_id: 'wh-1',
      supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
      supplier: { code: '400-H004', name: 'HOOKKA INDUSTRIES SDN. BHD.' },
    },
    ...over,
  }) as OutstandingPoItemRow;

/**
 * A PostgREST stand-in that RECORDS the chain instead of interpreting it.
 * fake-postgrest cannot help here: the assertions are about an embedded-resource
 * filter (`po.status` through an `!inner` join) and about paging, neither of
 * which it models — and a fake that quietly ignored `.in('po.status', …)` would
 * report a pass for the exact statement shape that caused the incident.
 */
function recordingSb(pages: OutstandingPoItemRow[][]) {
  const calls: Call[] = [];
  let page = 0;
  const from = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
      b[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return b; };
    }
    b.range = (lo: number, hi: number) => {
      calls.push({ method: 'range', args: [lo, hi] });
      const rows = pages[page] ?? [];
      page += 1;
      return Promise.resolve({ data: rows, error: null });
    };
    return b;
  };
  return { sb: { from } as unknown as OutstandingPoItemsClient, calls };
}

/** An active company, the ordinary case. */
const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) };

const used = (calls: Call[], method: string) => calls.filter((c) => c.method === method);

describe('fetchOutstandingPoItems: the statement may not silently truncate', () => {
  it('never asks for a fixed number of rows — that is what hid 168 lines', async () => {
    const { sb, calls } = recordingSb([[line()]]);
    await fetchOutstandingPoItems(sb, ctx, OPEN);

    /* The regression, stated as the thing that must not come back. A
       `.limit(500)` here reads an arbitrary slice; a `.limit(5000)` reads an
       arbitrary 1000, because PostgREST caps a response at 1000 rows whatever
       the limit says and drops the rest with no error. */
    expect(used(calls, 'limit')).toHaveLength(0);
    expect(used(calls, 'range')).not.toHaveLength(0);
  });

  it('filters the parent status in the QUERY, so the read stays bounded to open work', async () => {
    const { sb, calls } = recordingSb([[line()]]);
    await fetchOutstandingPoItems(sb, ctx, OPEN);

    /* Applied through the `!inner` embed, so it drops the top-level row rather
       than merely blanking the embedded one. Filtering this in JS afterwards is
       what made the old 500 be spent on lines that were never candidates. */
    const statusFilter = used(calls, 'in').find((call) => call.args[0] === 'po.status');
    expect(statusFilter).toBeDefined();
    expect(statusFilter?.args[1]).toEqual(['SUBMITTED', 'PARTIALLY_RECEIVED']);
  });

  it('sorts by a TOTAL order, so a paged read cannot repeat or skip a row', async () => {
    const { sb, calls } = recordingSb([[line()]]);
    await fetchOutstandingPoItems(sb, ctx, OPEN);

    /* Every line of one purchase order shares purchase_order_id, so it is not a
       total order on its own and page boundaries land mid-group. */
    const orderCols = used(calls, 'order').map((call) => call.args[0]);
    expect(orderCols).toContain('purchase_order_id');
    expect(orderCols).toContain('id');
  });

  it('reads EVERY page, not just the first', async () => {
    /* A full page is the only thing that tells paginateAll to ask again, so the
       first page has to be genuinely full or this proves nothing. */
    const full = Array.from({ length: 1000 }, (_, i) => line({ id: `a-${i}` }));
    const { sb, calls } = recordingSb([full, [line({ id: 'b-0' })]]);

    const { data } = await fetchOutstandingPoItems(sb, ctx, OPEN);

    expect(used(calls, 'range')).toHaveLength(2);
    expect(used(calls, 'range')[0].args).toEqual([0, 999]);
    expect(used(calls, 'range')[1].args).toEqual([1000, 1999]);
    expect(data).toHaveLength(1001);
  });

  it('still drops a line whose balance is zero', async () => {
    /* The one filter that cannot move into the statement — it compares two
       COLUMNS, which PostgREST has no filter for. */
    const { sb } = recordingSb([[
      line({ id: 'open', qty: 2, received_qty: 1 }),
      line({ id: 'done', qty: 1, received_qty: 1 }),
      line({ id: 'over', qty: 1, received_qty: 3 }),
    ]]);

    const { data } = await fetchOutstandingPoItems(sb, ctx, OPEN);
    expect(data?.map((r) => r.id)).toEqual(['open']);
  });

  it('carries the company predicate, and fails CLOSED when no company resolves', async () => {
    const scoped = recordingSb([[line()]]);
    await fetchOutstandingPoItems(scoped.sb, ctx, OPEN);
    expect(used(scoped.calls, 'eq').find((call) => call.args[0] === 'company_id')?.args[1]).toBe(1);

    /* companyId unset but allowedCompanyIds RESOLVED = the caller may see
       nothing. The service-role client bypasses RLS, so this predicate is the
       whole tenant boundary and it must match nothing rather than everything.
       It is also why the picker's empty state may not claim the work is done. */
    const closed = recordingSb([[line()]]);
    await fetchOutstandingPoItems(
      closed.sb,
      { get: (k: string) => (k === 'allowedCompanyIds' ? [] : undefined) },
      OPEN,
    );
    expect(used(closed.calls, 'in').find((call) => call.args[0] === 'company_id')?.args[1]).toEqual([]);
  });

  it('reports a read error instead of returning an empty list', async () => {
    /* An error rendered as emptiness is the same failure the empty-state copy
       had: "we could not look" must never arrive as "there is nothing". */
    const sb = { from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order']) b[m] = () => b;
      b.range = () => Promise.resolve({ data: null, error: { message: 'boom' } });
      return b;
    } } as unknown as OutstandingPoItemsClient;

    const { data, error } = await fetchOutstandingPoItems(sb, ctx, OPEN);
    expect(error?.message).toBe('boom');
    expect(data).toBeNull();
  });
});
