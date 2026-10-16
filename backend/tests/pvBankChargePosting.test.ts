// DEV-75: a Payment Voucher's header Bank Charges post with the voucher —
// Dr 900-B001 / Cr the bank it pays from (Finance, 2026-10-14) — in the same
// journal, so a cancel's contra takes them back too. When 900-B001 is not a
// usable expense leaf of the company, the post is refused: never silently
// posted without the fee.
//
// Same bare-Hono + fake PostgREST harness as tests/pvRateFromPayment.test.ts.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
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

const linesOf = (t: Row, jeId: string) => (t.journal_entry_lines as Row[]).filter((l) => l.journal_entry_id === jeId);
const sum = (ls: Row[], k: string) => ls.reduce((s, l) => s + Number(l[k] ?? 0), 0);

describe('PV bank charges post to 900-B001 (DEV-75)', () => {
  test('a fee adds Dr 900-B001 / Cr the bank, and the entry balances', async () => {
    const t = world(250);
    const res = await harness(t).request('/pv/pv-1/post', { method: 'POST' });
    expect(res.status).toBe(200);
    const je = t.journal_entries[0]!;
    const ls = linesOf(t, je.id);
    expect(ls.find((l) => l.account_code === '900-B001')).toMatchObject({ debit_sen: 250, credit_sen: 0 });
    expect(ls.filter((l) => l.account_code === '310-0010').map((l) => l.credit_sen).sort((a, b) => a - b)).toEqual([250, 10_000]);
    expect(sum(ls, 'debit_sen')).toBe(10_250);
    expect(sum(ls, 'credit_sen')).toBe(10_250);
    expect(je.entry_date).toBe('2026-10-14');
    expect(je.source_type).toBe('PV');
  });

  test('a foreign voucher posts the fee as keyed in MYR, not through the rate', async () => {
    const t = world(250, CHART({}), { currency: 'USD', exchange_rate: 4.5 });
    expect((await harness(t).request('/pv/pv-1/post', { method: 'POST' })).status).toBe(200);
    expect(t.journal_entry_lines.find((l) => l.account_code === '900-B001')).toMatchObject({ debit_sen: 250 });
  });

  test('no fee, no extra lines', async () => {
    const t = world(0);
    expect((await harness(t).request('/pv/pv-1/post', { method: 'POST' })).status).toBe(200);
    expect(t.journal_entry_lines).toHaveLength(2);
    expect(t.journal_entry_lines.some((l) => l.account_code === '900-B001')).toBe(false);
  });

  test('a cancel reverses the fee lines with the rest', async () => {
    const t = world(250);
    const app = harness(t);
    expect((await app.request('/pv/pv-1/post', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/pv/pv-1/cancel', { method: 'POST' })).status).toBe(200);
    const contra = t.journal_entries.find((j) => j.id !== t.journal_entries[0]!.id)!;
    expect(contra).toBeTruthy();
    const ls = linesOf(t, contra.id);
    expect(ls.find((l) => l.account_code === '900-B001')).toMatchObject({ debit_sen: 0, credit_sen: 250 });
    expect(sum(ls, 'debit_sen')).toBe(10_250);
    expect(sum(ls, 'credit_sen')).toBe(10_250);
  });

  test.each([
    ['missing', CHART(null), /not in this company's chart/],
    ['switched off', CHART({ is_active: false }), /switched off/],
    ['not an expense', CHART({ account_type: 'ASSET' }), /a bank charge is an expense/],
  ])('900-B001 %s: the post is refused and nothing is written', async (_why, chart, msg) => {
    const t = world(250, chart);
    const res = await harness(t).request('/pv/pv-1/post', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json() as Row;
    expect(body.error).toBe('bank_charge_account');
    expect(body.message).toMatch(msg);
    expect(t.journal_entries).toHaveLength(0);
    expect(t.payment_vouchers[0]!.status).toBe('DRAFT');
  });
});
