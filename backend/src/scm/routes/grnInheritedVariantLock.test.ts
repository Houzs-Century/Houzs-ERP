// Owner 2026-08-20: "如果 PO 开成 GR，那我不可以在 GR 里改那个 variant — 我应该
// 把 GR cancel 掉，然后再去 PO 里改." A GRN line that was received FROM a PO
// inherits its item / category / variant from that PO; those are read-only on
// the receipt. Only the line's own receipt data (qty / cost / batch / delivery)
// is editable there. This drives the REAL PATCH /:id/items/:itemId handler and
// asserts the inherited-field lock:
//   1. changing the VARIANT of a PO-linked line is refused (409) and nothing is
//      written;
//   2. editing that same line's QTY still works;
//   3. a MANUAL line (no purchase_order_item_id) can still change its variant.
//
// The refusal compares the rendered variant SUMMARY, not raw JSON, so an
// unchanged-but-re-serialised payload does not false-trip (case 2 sends the same
// variants back alongside a qty change and must succeed).
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const SOFA_A = { seatHeight: '20', fabricCode: 'F-101' };

// The fake has no rpc(); the audit pre-flight probe (assertAuditWritable) calls
// sb.rpc('entity_audit_writable') and fails CLOSED without it. Stub it writable,
// same as pvBlankVoucherDate.test.ts, so the line edit reaches the rule under test.
const sb = Object.assign(
  fakeSb({
    grns: [{ id: 'grn-1', grn_number: 'GRN-2608-001', status: 'DRAFT', company_id: 1, purchase_order_id: 'po-1', warehouse_id: 'wh-1' }],
    grn_items: [
      { id: 'li-po', company_id: 1, grn_id: 'grn-1', purchase_order_item_id: 'poi-1', item_code: 'SOFA-A', item_group: 'sofa', variants: SOFA_A, qty_received: 5, qty_accepted: 5, unit_price_sen: 10000, discount_sen: 0, line_total_sen: 50000 },
      { id: 'li-manual', company_id: 1, grn_id: 'grn-1', purchase_order_item_id: null, item_code: 'SOFA-M', item_group: 'sofa', variants: SOFA_A, qty_received: 2, qty_accepted: 2, unit_price_sen: 10000, discount_sen: 0, line_total_sen: 20000 },
    ],
    purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1', item_code: 'SOFA-A', qty: 5, received_qty: 5 }],
    inventory_balances: [],
    entity_audit_log: [],
  }),
  { rpc: async () => ({ data: true, error: null }) },
);

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const line = (id: string) => (sb.tables.grn_items.find((r) => r.id === id) ?? {}) as Row;

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { grns } = await import('./grns');

async function patchLine(itemId: string, body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', grns);
  return app.request(`/grn-1/items/${itemId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PATCH grn line — inherited-variant lock', () => {
  it('refuses changing the variant of a PO-linked line (cancel GRN, edit PO)', async () => {
    const res = await patchLine('li-po', { variants: { seatHeight: '24', fabricCode: 'F-999' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'grn_inherited_field_locked' });
    // nothing written — the stored variant is untouched
    expect(line('li-po').variants).toEqual(SOFA_A);
  });

  it('still lets the PO-linked line change its own qty (variant echoed unchanged)', async () => {
    const res = await patchLine('li-po', { qty: 4, variants: SOFA_A });
    expect(res.status).toBe(200);
    expect(line('li-po').qty_received).toBe(4);
  });

  it('lets a MANUAL (unlinked) line change its variant', async () => {
    const res = await patchLine('li-manual', { variants: { seatHeight: '24', fabricCode: 'F-999' } });
    expect(res.status).toBe(200);
    expect((line('li-manual').variants as Record<string, unknown>).seatHeight).toBe('24');
  });
});
