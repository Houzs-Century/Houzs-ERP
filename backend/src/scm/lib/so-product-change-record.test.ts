// Owner 2026-11-23: every product change is recorded when it is saved or
// approved, for Finance's two reports. One record is one window of changes to
// one order: a Malaysia day of direct edits, or one amendment submission (its
// LINES and PRICE halves together). These pin the window: the first write keeps
// the lines as they were, every write after recomputes against the lines now,
// and parallel saves end on the final state. Amounts are made up.
import { describe, expect, it } from 'vitest';
import {
  amendmentSubmissionKey, closeChangeWindow, isLaterChange, openChangeWindow, readOrderDays, type ChangeWindow, type SubmittedAmendment,
} from './so-product-change-record';

type Row = Record<string, unknown>;

/** An in-memory PostgREST stand-in: the tables the record reads and writes. */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'upsert' = 'select';
    let patch: Row | null = null;
    let upsertRow: Row | null = null;
    let onConflict: string[] = [];
    const rows = () => (tables[table] ??= []);
    const matched = () => rows().filter((r) => filters.every((f) => f(r)));
    const run = (): { data: unknown; error: null } => {
      calls.push(`${op}:${table}`);
      if (op === 'update') { matched().forEach((r) => Object.assign(r, patch)); return { data: null, error: null }; }
      if (op === 'upsert') {
        const clash = rows().find((r) => onConflict.every((k) => r[k] === upsertRow![k]));
        if (!clash) rows().push({ id: `w${rows().length + 1}`, change_types: [], changed_by: [], approved_by: [], amendment_nos: [], ...upsertRow });
        return { data: null, error: null };
      }
      return { data: matched(), error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST builder stand-in: every method hands itself back.
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      gte: (k: string, v: string) => { filters.push((r) => String(r[k]) >= v); return b; },
      lte: (k: string, v: string) => { filters.push((r) => String(r[k]) <= v); return b; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; },
      update: (p: Row) => { op = 'update'; patch = p; return b; },
      upsert: (r: Row, o: { onConflict: string }) => { op = 'upsert'; upsertRow = r; onConflict = o.onConflict.split(','); return b; },
      maybeSingle: () => Promise.resolve(run()).then((res) => ({ data: (res.data as Row[] | null)?.[0] ?? null, error: null })),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
    };
    return b;
  };
  return { sb: { from }, tables, calls };
}

const line = (id: string, code: string, total: number, cost: number, extra: Row = {}): Row => ({
  id, company_id: 1, doc_no: 'HC-SO-T1', item_code: code, item_group: 'mattress', variants: {}, qty: 1,
  total_sen: total, line_cost_sen: cost, cancelled: false, ...extra,
});
const W: ChangeWindow = { companyId: 1, docNo: 'HC-SO-T1', route: 'DIRECT', windowKey: '2026-11-23' };

describe('the change window', () => {
  it('keeps the lines as they were, then records the event against the lines now', async () => {
    const db = fakeDb({
      mfg_sales_order_items: [line('1', 'JAGER-(Q)', 300000, 120000), line('2', 'SVC-DELIVERY', 10000, 0, { item_group: 'service' })],
      mfg_products: [],
    });
    const id = await openChangeWindow(db.sb, W, '2026-11-23');
    expect(id).toBe('w1');
    Object.assign(db.tables.mfg_sales_order_items![0]!, { item_code: 'NTYR-(Q)', total_sen: 320000, line_cost_sen: 150000 });
    await closeChangeWindow(db.sb, W, id!, { changedBy: 'Ali', changeDay: '2026-11-23' });
    const rec = db.tables.so_product_changes![0]!;
    expect(rec).toMatchObject({
      company_id: 1, route: 'DIRECT', window_key: '2026-11-23', change_types: ['sku'], bucket: 'SELLING',
      selling_before_sen: 300000, selling_after_sen: 320000, cost_before_sen: 120000, cost_after_sen: 150000, changed_by: ['Ali'],
    });
  });

  it('a second write the same day reuses the window and keeps the first before-lines', async () => {
    const db = fakeDb({ mfg_sales_order_items: [line('1', 'JAGER-(Q)', 300000, 120000)], mfg_products: [] });
    const id = await openChangeWindow(db.sb, W, '2026-11-23');
    Object.assign(db.tables.mfg_sales_order_items![0]!, { total_sen: 280000 });
    expect(await openChangeWindow(db.sb, W, '2026-11-23')).toBe(id);
    expect(db.tables.so_product_changes).toHaveLength(1);
    expect((db.tables.so_product_changes![0]!.before_lines as Row[])[0]!.sellingSen).toBe(300000);
  });

  it('a window with no product change is not an event', async () => {
    const db = fakeDb({ mfg_sales_order_items: [line('1', 'JAGER-(Q)', 300000, 120000)], mfg_products: [] });
    const id = await openChangeWindow(db.sb, W, '2026-11-23');
    Object.assign(db.tables.mfg_sales_order_items![0]!, { total_sen: 280000 });
    await closeChangeWindow(db.sb, W, id!, { changedBy: 'Ali', changeDay: '2026-11-23' });
    expect(db.tables.so_product_changes![0]!.bucket).toBeNull();
  });

  it('a line saved in parallel after the read is picked up before the close returns', async () => {
    const db = fakeDb({ mfg_sales_order_items: [line('1', 'JAGER-(Q)', 300000, 120000), line('2', 'CODY-(Q)', 100000, 40000, { item_group: 'bedframe' })], mfg_products: [] });
    const id = await openChangeWindow(db.sb, W, '2026-11-23');
    Object.assign(db.tables.mfg_sales_order_items![0]!, { item_code: 'NTYR-(Q)', line_cost_sen: 130000 });
    let reads = 0;
    const sb = { from: (t: string) => {
      const q = db.sb.from(t);
      if (t === 'mfg_sales_order_items' && ++reads === 2) Object.assign(db.tables.mfg_sales_order_items![1]!, { total_sen: 120000 });
      return q;
    } };
    await closeChangeWindow(sb, W, id!, { changedBy: 'Ali', changeDay: '2026-11-23' });
    expect(db.tables.so_product_changes![0]).toMatchObject({ selling_after_sen: 420000, bucket: 'SELLING' });
  });
});

describe('the order days', () => {
  it('reads the opening day in Malaysia and the order date, from the order\'s own company', async () => {
    const db = fakeDb({ mfg_sales_orders: [{ company_id: 1, doc_no: 'HC-SO-T1', created_at: '2026-11-01T17:30:00Z', so_date: '2026-10-28', status: 'CONFIRMED' }] });
    expect(await readOrderDays(db.sb, 1, 'HC-SO-T1')).toEqual({ openingDay: '2026-11-02', orderDay: '2026-10-28', status: 'CONFIRMED' });
    expect(await readOrderDays(db.sb, 2, 'HC-SO-T1')).toBeNull();
  });
  it('counts a change only after the opening day, on a live order', () => {
    const d = { openingDay: '2026-11-02', orderDay: '2026-10-28', status: 'CONFIRMED' };
    expect(isLaterChange(d, '2026-11-02')).toBe(false);
    expect(isLaterChange(d, '2026-11-03')).toBe(true);
    expect(isLaterChange({ ...d, status: 'DRAFT' }, '2026-11-03')).toBe(false);
    expect(isLaterChange(null, '2026-11-03')).toBe(false);
  });
});

describe('the amendment submission', () => {
  it('the halves of one submission share the first half\'s id; another submission does not', async () => {
    const rows: SubmittedAmendment[] = [
      { id: 'b', so_doc_no: 'HC-SO-T1', requested_by: 's1', reason: 'customer wants K', created_at: '2026-11-20T03:00:00.400Z' },
      { id: 'a', so_doc_no: 'HC-SO-T1', requested_by: 's1', reason: 'customer wants K', created_at: '2026-11-20T03:00:00.100Z' },
      { id: 'c', so_doc_no: 'HC-SO-T1', requested_by: 's1', reason: 'delivery date', created_at: '2026-11-20T03:00:00.200Z' },
    ];
    const db = fakeDb({ so_amendments: rows.map((r) => ({ ...r })) });
    expect(await amendmentSubmissionKey(db.sb, rows[0]!)).toBe('a');
    expect(await amendmentSubmissionKey(db.sb, rows[1]!)).toBe('a');
    expect(await amendmentSubmissionKey(db.sb, rows[2]!)).toBe('c');
  });
});
