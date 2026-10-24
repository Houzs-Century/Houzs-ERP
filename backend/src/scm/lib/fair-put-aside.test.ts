/* Fair Links — an order a person PUTS ASIDE (owner 2026-10-21: 「还有一些我看了
   是 service 要 put aside 的」). Pinned here:
     • putting aside records when and who on the order, and a History row;
     • doing it twice writes nothing the second time;
     • bringing it back clears both;
     • another company's order is not found;
     • the folded group lists them latest first, never a cancelled one;
     • a put-aside order leaves the list and the menu's count. */

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from './fake-postgrest';
import { countFairPending, loadFairPending } from './fair-pending';
import { loadFairPutAside, setFairPutAside } from './fair-put-aside';

const so = (doc: string, over: Row = {}): Row => ({
  doc_no: doc, company_id: 1, so_date: '2026-10-06', venue: 'MID VALLEY', branding: 'SERVICE',
  project_id: null, fair_match: 'UNMATCHED', status: 'CONFIRMED', local_total_sen: 15000, salesperson_id: 's1', ...over,
});
const client = (tables: Record<string, Row[]>) => fakeSb(tables) as unknown as SupabaseClient;
const scope1 = <Q,>(q: Q): Q => (q as unknown as { eq(c: string, v: unknown): Q }).eq('company_id', 1);
const asChew = { companyId: 1, actorId: null, actorName: 'Chew' };

describe('putting an order aside', () => {
  it('records when and who, with a History row; a second time writes nothing', async () => {
    const tables: Record<string, Row[]> = { mfg_sales_orders: [so('HC-SO-2610-066')], mfg_so_audit_log: [] };
    const sb = client(tables);
    expect(await setFairPutAside({ sb, docNo: 'HC-SO-2610-066', aside: true, ...asChew })).toEqual({ ok: true, changed: true });
    const order = tables.mfg_sales_orders![0]!;
    expect(order.fair_put_aside_by).toBe('Chew');
    expect(typeof order.fair_put_aside_at).toBe('string');
    expect(tables.mfg_so_audit_log).toEqual([expect.objectContaining({
      so_doc_no: 'HC-SO-2610-066', action: 'UPDATE_FAIR', source: 'settle',
      field_changes: [{ field: 'Fair Links', from: 'Listed', to: 'Put aside' }],
    })]);
    expect(await setFairPutAside({ sb, docNo: 'HC-SO-2610-066', aside: true, ...asChew })).toEqual({ ok: true, changed: false });
    expect(tables.mfg_so_audit_log).toHaveLength(1);
  });

  it('bringing it back clears both', async () => {
    const tables: Record<string, Row[]> = {
      mfg_sales_orders: [so('HC-SO-2610-066', { fair_put_aside_at: '2026-10-21T09:00:00Z', fair_put_aside_by: 'Chew' })],
      mfg_so_audit_log: [],
    };
    expect(await setFairPutAside({ sb: client(tables), docNo: 'HC-SO-2610-066', aside: false, ...asChew })).toEqual({ ok: true, changed: true });
    expect(tables.mfg_sales_orders![0]).toMatchObject({ fair_put_aside_at: null, fair_put_aside_by: null });
    expect(tables.mfg_so_audit_log![0]).toMatchObject({ field_changes: [{ field: 'Fair Links', from: 'Put aside', to: 'Listed' }] });
  });

  it('another company’s order is not found', async () => {
    const tables: Record<string, Row[]> = { mfg_sales_orders: [so('2990-SO-2610-001', { company_id: 2 })], mfg_so_audit_log: [] };
    expect(await setFairPutAside({ sb: client(tables), docNo: '2990-SO-2610-001', aside: true, ...asChew })).toEqual({ ok: false, reason: 'not_found' });
    expect(tables.mfg_sales_orders![0]!.fair_put_aside_at).toBeUndefined();
  });
});

describe('the put-aside group, and the list without them', () => {
  const ROWS = (): Row[] => [
    so('HC-SO-2610-066', { fair_put_aside_at: '2026-10-21T09:00:00Z', fair_put_aside_by: 'Chew' }),
    so('HC-SO-2610-035', { fair_put_aside_at: '2026-10-21T10:00:00Z', fair_put_aside_by: 'Chew' }),
    so('HC-SO-2610-099', { fair_put_aside_at: '2026-10-21T11:00:00Z', status: 'CANCELLED' }),
    so('HC-SO-2610-060', { fair_match: 'AMBIGUOUS', branding: 'AKEMI' }),
  ];

  it('lists the put-aside orders, latest first, never a cancelled one', async () => {
    const res = await loadFairPutAside(client({ mfg_sales_orders: ROWS() }), scope1, 200);
    expect(res.ok && res.rows.map((r) => [r.doc_no, r.fair_put_aside_by])).toEqual([['HC-SO-2610-035', 'Chew'], ['HC-SO-2610-066', 'Chew']]);
  });

  it('a put-aside order leaves the list and the menu’s count', async () => {
    const sb = fakeSb({ mfg_sales_orders: ROWS() });
    const [list, count] = await Promise.all([loadFairPending(sb, scope1, 500), countFairPending(sb, scope1)]);
    expect(list.ok && list.rows.map((r) => r.doc_no)).toEqual(['HC-SO-2610-060']);
    expect(count).toEqual({ ok: true, count: 1 });
  });
});
