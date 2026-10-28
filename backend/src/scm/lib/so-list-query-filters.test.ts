// What each second-level Sales Order list filter asks the database for. The
// list reads PostgREST, so a filter IS the predicate chain it appends — these
// record that chain on a fake builder and pin it, column by column, because a
// filter that reads the wrong column returns plausible rows and says nothing.
import { describe, expect, it, vi } from 'vitest';
import {
  applySoListFilters,
  resolveOwnStaffIds,
  soListCountSource,
  soListFiltersNeedMe,
  prepareSoListFilters,
} from './so-list-query-filters';
import type { SoListFilter } from '../shared/so-list-filter-model';

type Call = [string, ...unknown[]];

function recorder() {
  const calls: Call[] = [];
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'in', 'or', 'not', 'is', 'overlaps']) {
    q[m] = (...args: unknown[]) => { calls.push([m, ...args]); return q; };
  }
  return { q, calls };
}

const ME = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
const ctx = { myStaffIds: ME, todayYmd: '2026-09-14' };
const run = (...filters: SoListFilter[]) => {
  const { q, calls } = recorder();
  applySoListFilters(q, filters, ctx);
  return calls;
};

describe('who', () => {
  it('"created by is me" and "salesperson is me" read the order owner, resolved server-side', () => {
    expect(run({ field: 'createdBy', op: 'me', value: '' })).toEqual([['in', 'salesperson_id', ME]]);
    expect(run({ field: 'salesperson', op: 'me', value: '' })).toEqual([['in', 'salesperson_id', ME]]);
  });
  it('a named person is an exact staff id match', () => {
    const id = 'c115a11d-5a53-40c1-820a-c64cc4d9b4fb';
    expect(run({ field: 'salesperson', op: 'is', value: id })).toEqual([['eq', 'salesperson_id', id]]);
  });
});

describe('text', () => {
  it('contains is a substring match on the column the list shows', () => {
    expect(run({ field: 'venue', op: 'contains', value: ' IOI ' })).toEqual([['ilike', 'venue', '%IOI%']]);
    expect(run({ field: 'name', op: 'contains', value: 'tan' })).toEqual([['ilike', 'debtor_name', '%tan%']]);
    expect(run({ field: 'state', op: 'is', value: 'Johor' })).toEqual([['ilike', 'customer_state', 'Johor']]);
    expect(run({ field: 'salesLocation', op: 'contains', value: 'PJ' })).toEqual([['ilike', 'sales_location', '%PJ%']]);
  });
  it('reference searches both columns the Reference cell can display', () => {
    expect(run({ field: 'reference', op: 'contains', value: 'PG10(213)' }))
      .toEqual([['or', 'ref.ilike.%PG10_213_%,customer_so_no.ilike.%PG10_213_%']]);
  });
  it('remarks searches the note and the three remark columns', () => {
    expect(run({ field: 'remarks', op: 'contains', value: 'lift' }))
      .toEqual([['or', 'note.ilike.%lift%,remark2.ilike.%lift%,remark3.ilike.%lift%,remark4.ilike.%lift%']]);
  });
  it('contact no. also matches the canonical +60 form of a local number', () => {
    const calls = run({ field: 'contactNo', op: 'contains', value: '012-345 6789' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('or');
    expect(String(calls[0][1])).toContain('phone.ilike.%012-345 6789%');
    expect(String(calls[0][1])).toContain('phone.ilike.%60123456789%');
  });
});

describe('order number and dates', () => {
  it('SO no. from..to is an inclusive range with either end open', () => {
    expect(run({ field: 'docNo', op: 'between', value: 'HC-SO-013000~HC-SO-013100' }))
      .toEqual([['gte', 'doc_no', 'HC-SO-013000'], ['lte', 'doc_no', 'HC-SO-013100']]);
    expect(run({ field: 'docNo', op: 'between', value: '~HC-SO-013100' })).toEqual([['lte', 'doc_no', 'HC-SO-013100']]);
  });
  it('a date column takes an inclusive window; presets resolve against today in KL', () => {
    expect(run({ field: 'deliveryDate', op: 'preset', value: 'this_week' }))
      .toEqual([['gte', 'customer_delivery_date', '2026-09-14'], ['lte', 'customer_delivery_date', '2026-09-20']]);
    expect(run({ field: 'processingDate', op: 'before', value: '2026-09-01' }))
      .toEqual([['lte', 'processing_date', '2026-08-31']]);
    expect(run({ field: 'orderDate', op: 'on', value: '2026-09-02' }))
      .toEqual([['gte', 'so_date', '2026-09-02'], ['lte', 'so_date', '2026-09-02']]);
  });
  it('a timestamp column is bounded by Kuala Lumpur midnights, end exclusive', () => {
    expect(run({ field: 'createdDate', op: 'between', value: '2026-09-01~2026-09-30' }))
      .toEqual([['gte', 'created_at', '2026-09-01T00:00:00+08:00'], ['lt', 'created_at', '2026-10-01T00:00:00+08:00']]);
    expect(run({ field: 'lastChangeDate', op: 'after', value: '2026-09-13' }))
      .toEqual([['gte', 'updated_at', '2026-09-14T00:00:00+08:00']]);
  });
});

describe('money', () => {
  it('balance reads the ledger-derived live balance in whole sen', () => {
    expect(run({ field: 'balance', op: 'positive', value: '' })).toEqual([['gt', 'balance_sen_live', 0]]);
    expect(run({ field: 'balance', op: 'gt', value: '100.5' })).toEqual([['gt', 'balance_sen_live', 10050]]);
    expect(run({ field: 'balance', op: 'eq', value: '0' })).toEqual([['eq', 'balance_sen_live', 0]]);
    expect(run({ field: 'balance', op: 'between', value: '100~2500' }))
      .toEqual([['gte', 'balance_sen_live', 10000], ['lte', 'balance_sen_live', 250000]]);
  });
  it('total reads the order total', () => {
    expect(run({ field: 'total', op: 'lt', value: '1000' })).toEqual([['lt', 'local_total_sen', 100000]]);
  });
  it('payment status partitions on the same paid / balance columns the list shows', () => {
    expect(run({ field: 'paymentStatus', op: 'is', value: 'unpaid' }))
      .toEqual([['lte', 'paid_total_sen', 0], ['gt', 'balance_sen_live', 0]]);
    expect(run({ field: 'paymentStatus', op: 'is', value: 'deposit' }))
      .toEqual([['gt', 'paid_total_sen', 0], ['gt', 'balance_sen_live', 0]]);
    expect(run({ field: 'paymentStatus', op: 'is', value: 'paid' })).toEqual([['lte', 'balance_sen_live', 0]]);
  });
  it('overdue = effective delivery date before today and not yet out of the door', () => {
    expect(run({ field: 'overdue', op: 'is', value: 'yes' })).toEqual([
      ['or', 'amended_delivery_date.lt.2026-09-14,and(amended_delivery_date.is.null,customer_delivery_date.lt.2026-09-14)'],
      ['not', 'status', 'in', '(SHIPPED,DELIVERED,INVOICED,CLOSED,CANCELLED)'],
    ]);
  });
});

describe('line-level fields read the computed fields the migration adds', () => {
  it('warehouse: the order has a live line in that warehouse', () => {
    const id = 'e309c399-697c-4174-967f-ae2c888ad999';
    expect(run({ field: 'warehouse', op: 'is', value: id })).toEqual([['overlaps', 'so_line_warehouse_ids', [id]]]);
  });
  it('item category: the order has a live line in that bucket', () => {
    expect(run({ field: 'itemCategory', op: 'is', value: 'sofa' })).toEqual([['overlaps', 'so_line_categories', ['SOFA']]]);
    expect(run({ field: 'itemCategory', op: 'is', value: 'accessory' })).toEqual([['overlaps', 'so_line_categories', ['ACCESSORY']]]);
  });
  it('pending amendment: yes and no are both a real predicate', () => {
    expect(run({ field: 'pendingAmendment', op: 'is', value: 'yes' })).toEqual([['is', 'so_has_open_amendment', true]]);
    expect(run({ field: 'pendingAmendment', op: 'is', value: 'no' })).toEqual([['is', 'so_has_open_amendment', false]]);
  });
  it('branding is the header column', () => {
    expect(run({ field: 'branding', op: 'contains', value: 'aKemi' })).toEqual([['ilike', 'branding', '%aKemi%']]);
  });
});

describe('composition', () => {
  it('rows AND together in order and an empty list leaves the query untouched', () => {
    expect(run()).toEqual([]);
    expect(run(
      { field: 'createdBy', op: 'me', value: '' },
      { field: 'balance', op: 'positive', value: '' },
    )).toEqual([['in', 'salesperson_id', ME], ['gt', 'balance_sen_live', 0]]);
  });

  it('an incomplete row that slipped past the parser is refused, never applied loosely', () => {
    expect(() => run({ field: 'name', op: 'contains', value: '' })).toThrow(/invalid filter/);
  });

  it('knows when "me" must be resolved and when counts must read the view', () => {
    expect(soListFiltersNeedMe([{ field: 'venue', op: 'contains', value: 'x' }])).toBe(false);
    expect(soListFiltersNeedMe([{ field: 'createdBy', op: 'me', value: '' }])).toBe(true);
    expect(soListCountSource([])).toBe('mfg_sales_orders');
    expect(soListCountSource([{ field: 'venue', op: 'contains', value: 'x' }])).toBe('mfg_sales_orders_with_payment_totals');
  });
});

describe('resolveOwnStaffIds', () => {
  const sbWith = (result: { data: unknown; error: unknown }) => {
    const eq = vi.fn(async () => result);
    const select = vi.fn(() => ({ eq }));
    return { sb: { from: vi.fn(() => ({ select })) }, eq };
  };
  it('maps the signed-in user to their staff ids', async () => {
    const { sb, eq } = sbWith({ data: [{ id: ME[0] }], error: null });
    await expect(resolveOwnStaffIds(sb, 42)).resolves.toEqual({ ok: true, ids: ME });
    expect(eq).toHaveBeenCalledWith('user_id', 42);
  });
  it('a user with no staff row matches nothing rather than everything', async () => {
    const { sb } = sbWith({ data: [], error: null });
    await expect(resolveOwnStaffIds(sb, 42)).resolves.toEqual({ ok: true, ids: ['00000000-0000-0000-0000-000000000000'] });
    await expect(resolveOwnStaffIds(sb, null)).resolves.toEqual({ ok: true, ids: ['00000000-0000-0000-0000-000000000000'] });
  });
  it('a failed lookup is reported, not read as "no orders"', async () => {
    const { sb } = sbWith({ data: null, error: { message: 'boom' } });
    await expect(resolveOwnStaffIds(sb, 42)).resolves.toEqual({ ok: false, reason: 'boom' });
  });
});

describe('prepareSoListFilters — the one call the list handler makes', () => {
  const sbNoStaff = { from: () => ({ select: () => ({ eq: async () => ({ data: [{ id: ME[0] }], error: null }) }) }) };
  it('refuses an invalid row by name with a 400', async () => {
    const out = await prepareSoListFilters(sbNoStaff, ['balance:gt:lots'], 42, new Date('2026-09-14T04:00:00Z'));
    expect(out).toEqual({ ok: false, status: 400, body: { error: 'invalid_filter', invalid: ['balance:gt:lots'] } });
  });
  it('no filters: counts keep reading the base table and the builder is untouched', async () => {
    const out = await prepareSoListFilters(sbNoStaff, [], 42, new Date('2026-09-14T04:00:00Z'));
    if (!out.ok) throw new Error('expected ok');
    expect(out.countFrom).toBe('mfg_sales_orders');
    const { q, calls } = recorder();
    expect(out.apply(q)).toBe(q);
    expect(calls).toEqual([]);
  });
  it('resolves "me" once and applies every row, dated in Kuala Lumpur', async () => {
    const out = await prepareSoListFilters(sbNoStaff, ['createdBy:me', 'deliveryDate:preset:today'], 42, new Date('2026-09-14T17:30:00Z'));
    if (!out.ok) throw new Error('expected ok');
    expect(out.countFrom).toBe('mfg_sales_orders_with_payment_totals');
    const { q, calls } = recorder();
    out.apply(q);
    expect(calls).toEqual([
      ['in', 'salesperson_id', ME],
      ['gte', 'customer_delivery_date', '2026-09-15'],
      ['lte', 'customer_delivery_date', '2026-09-15'],
    ]);
  });
  it('a failed owner lookup is a 500 that says so', async () => {
    const sbFail = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'down' } }) }) }) };
    const out = await prepareSoListFilters(sbFail, ['createdBy:me'], 42, new Date());
    expect(out).toEqual({ ok: false, status: 500, body: { error: 'load_failed', reason: 'filter owner lookup failed: down' } });
  });
});
