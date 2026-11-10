// A posted voucher looks for its payment on the bank (owner 2026-11-10: 「银行单上写着
// PV 号码的，直接配那张 PV，不管差几天」 — 可以). The matching itself is pinned in
// tests/bankVoucherNumber.test.ts (matchBankLinesNamingVoucher); this pins the door:
// the post asks it with the voucher's number and the bank it paid from, and a bank
// read that fails never stops the post.
//
// Same bare-Hono + fake PostgREST harness as tests/pvBankChargePosting.test.ts.

import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

const asked = vi.hoisted(() => ({ calls: [] as unknown[][], fail: false }));
vi.mock('../src/scm/routes/accounting-bank', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scm/routes/accounting-bank')>()),
  matchBankLinesNamingVoucher: async (...args: unknown[]) => {
    asked.calls.push(args);
    if (asked.fail) throw new Error('bank read failed');
    return { ok: true, matched: 1, jeNos: ['JE-1'] };
  },
}));

import { postPaymentVoucherHandler, cancelPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  like() { return this; }
  is() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: r.id ?? `${this.table}-${this.rows.length + i + 1}`, ...r }));
      this.rows.push(...withIds);
      return withIds;
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  let n = 1;
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema() { return this; },
      rpc: async (fn: string) => {
        if (fn === 'entity_audit_writable') return { data: true, error: null };
        if (fn === 'next_doc_no_n') return { data: n++, error: null };
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      },
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/pv/:id/post', postPaymentVoucherHandler as never);
  app.post('/pv/:id/cancel', cancelPaymentVoucherHandler as never);
  return app;
}

const CHART = (fee: Row | null): Row[] => [
  { company_id: CO, account_code: '310-0010', account_type: 'ASSET', parent_code: null, is_active: true },
  { company_id: CO, account_code: '901-0000', account_type: 'EXPENSE', parent_code: null, is_active: true },
  ...(fee ? [{ company_id: CO, account_code: '900-B001', account_type: 'EXPENSE', parent_code: null, is_active: true, ...fee }] : []),
];

const world = (feeSen: number, chart: Row[] = CHART({}), over: Row = {}) => ({
  payment_vouchers: [{
    id: 'pv-1', pv_number: 'HC-PV-2610-001', company_id: CO, status: 'DRAFT',
    voucher_date: '2026-10-14', payee_name: 'TNB', credit_account_code: '310-0010',
    currency: 'MYR', exchange_rate: 1, purpose: 'OTHER', total_sen: 10_000, bank_charge_sen: feeSen,
    submitted_at: '2026-10-14T01:00:00Z', submitted_by: 'Tester', approved_at: '2026-10-14T02:00:00Z', approved_by: 'Tester',
    ...over,
  }],
  payment_voucher_lines: [{ id: 'l1', pv_id: 'pv-1', line_no: 1, description: 'Electricity', debit_account_code: '901-0000', amount_sen: 10_000 }],
  accounts: chart,
  journal_entries: [] as Row[], journal_entry_lines: [] as Row[], entity_audit_log: [] as Row[], suppliers: [] as Row[],
});


afterEach(() => { asked.calls.length = 0; asked.fail = false; });

describe('a posted voucher asks the bank for its payment', () => {
  test('with its number and the bank it paid from, once', async () => {
    const t = world(0);
    expect((await harness(t).request('/pv/pv-1/post', { method: 'POST' })).status).toBe(200);
    expect(asked.calls).toHaveLength(1);
    expect(asked.calls[0]!.slice(1, 3)).toEqual([CO, { pvNumber: 'HC-PV-2610-001', creditAccountCode: '310-0010' }]);
  });

  test('a bank read that fails never stops the post', async () => {
    asked.fail = true;
    const t = world(0);
    const res = await harness(t).request('/pv/pv-1/post', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(t.payment_vouchers[0]!.status).toBe('POSTED');
    expect(t.journal_entries).toHaveLength(1);
  });
});
