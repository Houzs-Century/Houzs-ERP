/* GET /sales-analysis/lines — the 2990 POS Marketing > Sales analysis feed.
 * Pinned: who may read it (the all-sales tier and the POS marketing account,
 * not an ordinary salesperson); the company boundary; which orders and lines
 * count; that the payload carries the customer's age but never the birthday,
 * the name on the order and its city but never the phone, and never a cost;
 * and that only a finance caller gets the margin, and only while
 * the cost display switch is on. The caller goes through the real SCM auth bridge, so the
 * Title fields reach the gate the way production stashes them. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const order = (doc_no: string, company_id: number, extra: Record<string, unknown> = {}) => ({
  doc_no, company_id, so_date: '2026-10-03', status: 'CONFIRMED', on_hold: false, venue: '2990s PJ',
  customer_id: 'cust-1', debtor_name: 'Tan Mei Ling', phone: '012-3456789', customer_race: 'Chinese',
  customer_birthday: '1990-10-05', customer_gender: 'Female', customer_state: 'Selangor', city: 'Petaling Jaya',
  total_margin_sen: 99999, ...extra,
});
const line = (id: string, doc_no: string, item_code: string, extra: Record<string, unknown> = {}) => ({
  id, doc_no, company_id: 2, line_no: 0, item_code, item_group: 'mattress', qty: 1, total_sen: 149000,
  cancelled: false, variants: null, line_cost_sen: 70000, line_margin_sen: 79000, ...extra,
});

const sb = fakeSb({
  mfg_sales_orders: [
    order('2990-SO-1', 2),
    order('2990-SO-DRAFT', 2, { status: 'DRAFT' }),
    order('2990-SO-CXL', 2, { status: 'CANCELLED' }),
    order('2990-SO-HOLD', 2, { on_hold: true }),
    order('HC-SO-1', 1),
  ],
  mfg_sales_order_items: [
    line('i1', '2990-SO-1', 'XAMMAR-2A(RHF)', { item_group: 'sofa', line_no: 1, total_sen: 157111, variants: { buildKey: 'build-1', cellIndex: 1 } }),
    line('i2', '2990-SO-1', 'XAMMAR-1A(LHF)', { item_group: 'sofa', line_no: 0, total_sen: 104389, variants: { buildKey: 'build-1', cellIndex: 0 } }),
    line('i3', '2990-SO-1', 'AKKA-FIRM-(K)', { line_no: 2 }),
    line('i4', '2990-SO-1', 'SVC-DELIVERY', { item_group: 'service', line_no: 3, total_sen: 15000 }),
    line('i5', '2990-SO-1', 'AKKA-FIRM-(K)', { line_no: 4, cancelled: true }),
    line('i6', '2990-SO-DRAFT', 'AKKA-FIRM-(K)'),
    line('i7', '2990-SO-CXL', 'AKKA-FIRM-(K)'),
    line('i8', '2990-SO-HOLD', 'AKKA-FIRM-(K)'),
    line('i9', 'HC-SO-1', 'AKKA-FIRM-(K)', { company_id: 1 }),
  ],
  mfg_products: [
    { code: 'XAMMAR-1A(LHF)', company_id: 2, category: 'SOFA', model_id: 'm-x', size_code: null, size_label: null, base_model: 'Xammar', cost_price_sen: 1 },
    { code: 'XAMMAR-2A(RHF)', company_id: 2, category: 'SOFA', model_id: 'm-x', size_code: null, size_label: null, base_model: 'Xammar', cost_price_sen: 1 },
    { code: 'AKKA-FIRM-(K)', company_id: 2, category: 'MATTRESS', model_id: 'm-a', size_code: 'K', size_label: '6FT', base_model: 'AKKA-FIRM', cost_price_sen: 1 },
  ],
  product_models: [
    { id: 'm-x', company_id: 2, name: 'XAMMAR' },
    { id: 'm-a', company_id: 2, name: 'AKKA-FIRM' },
  ],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const { salesAnalysis } = await import('./sales-analysis');

/** A Houzs session user, as the global /api auth hands it to the SCM bridge. */
const member = (position_name: string, permissions: string[] = []) => ({
  id: 41, email: 'm@2990.test', name: 'Member', position_name, department_name: 'Sales Department',
  permissions, permissions_set: new Set(permissions), position_policy: null,
});

function get(user: ReturnType<typeof member>, env: Record<string, string> = {}) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', user as never);
    c.set('companyId', 2);
    await next();
  });
  a.route('/', salesAnalysis);
  return a.request('/lines', {}, env as never);
}

describe('GET /sales-analysis/lines', () => {
  it('refuses an ordinary salesperson', async () => {
    const res = await get(member('Sales Executive'));
    expect(res.status).toBe(403);
    expect((await res.json() as { reason: string }).reason).toBe('sales_lines_requires_scm.so.view_all_or_pos_marketing');
  });

  it('serves the POS marketing account: one row per sold line, a sofa build folded left to right', async () => {
    const res = await get(member('Sales Marketing'));
    expect(res.status).toBe(200);
    const body = await res.json() as { includeTest: boolean; lines: Array<Record<string, unknown>> };
    expect(body.includeTest).toBe(false);
    expect(body.lines).toHaveLength(2);
    expect(body.lines).toContainEqual(expect.objectContaining({
      docNo: '2990-SO-1', category: 'SOFA', model: 'XAMMAR', modules: ['1A(LHF)', '2A(RHF)'], qty: 1, totalSen: 261500,
    }));
    expect(body.lines).toContainEqual(expect.objectContaining({
      docNo: '2990-SO-1', category: 'MATTRESS', model: 'AKKA-FIRM', sizeCode: 'K', sizeLabel: '6FT', totalSen: 149000,
      venue: '2990s PJ', race: 'Chinese', gender: 'Female', state: 'Selangor', age: 35,
      customerName: 'Tan Mei Ling', city: 'Petaling Jaya',
    }));
  });

  it('serves the all-sales tier', async () => {
    expect((await get(member('Operation Executive', ['scm.so.view_all']))).status).toBe(200);
  });

  it('keeps to the active company and to orders that are sales: no draft, cancelled or held order, no service or cancelled line', async () => {
    const body = await (await get(member('Sales Marketing'))).json() as { lines: Array<{ docNo: string }> };
    expect([...new Set(body.lines.map((l) => l.docNo))]).toEqual(['2990-SO-1']);
  });

  it('carries the age, never the birthday, the phone, a cost or a margin', async () => {
    const text = await (await get(member('Sales Marketing'))).text();
    expect(text).not.toContain('1990-10-05');
    expect(text).not.toContain('012-3456789');
    expect(text).not.toMatch(/birthday|phone|margin|cost/i);
  });

  it('gives a director the margin — revenue minus cost, not the stored line margin', async () => {
    const body = await (await get(member('Sales Director'))).json() as { lines: Array<{ category: string; marginSen?: number | null }> };
    expect(body.lines.find((l) => l.category === 'SOFA')!.marginSen).toBe((157111 - 70000) + (104389 - 70000));
    expect(body.lines.find((l) => l.category === 'MATTRESS')!.marginSen).toBe(149000 - 70000);
  });

  it('hides the margin from a director too while the cost display switch is off', async () => {
    const text = await (await get(member('Sales Director'), { COSTING_DISPLAY_ENABLED: 'false' })).text();
    expect(text).not.toMatch(/margin/i);
  });
});
