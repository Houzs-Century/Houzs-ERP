// Phase 3 through the ROUTES — the rule table is pv-approval.test.ts; what
// this file proves is what a pure function cannot:
//   · submit / approve / withdraw / reject actually move the marks on the row
//     and each leaves an audit entry naming who;
//   · the approve/reject door checks scm.payment_voucher.approve, not write —
//     a writer without the key is turned away;
//   · the EDIT door refuses a voucher in the queue;
//   · the POST door refuses an unapproved voucher (the gate in the handler,
//     not just the table);
//   · a reject carries its note onto the audit trail, where the submitter
//     reads the why.
//
// Same bare-Hono + fake-PostgREST harness as tests/pvRateFromPayment.test.ts,
// trimmed to the tables these handlers touch. NO vi.mock, deliberately.

import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  submitPaymentVoucherHandler, withdrawPaymentVoucherHandler,
  approvePaymentVoucherHandler, rejectPaymentVoucherHandler,
  updatePaymentVoucherHandler, postPaymentVoucherHandler,
} from '../src/scm/routes/payment-vouchers';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  not(col: string, op: string, val: unknown) {
    if (op === 'is' && val === null) this.preds.push((r) => r[col] != null);
    return this;
  }
  lte(col: string, val: unknown) { this.preds.push((r) => String(r[col]) <= String(val)); return this; }
  is(col: string, val: unknown) { if (val === null) this.preds.push((r) => r[col] == null); return this; }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: r.id ?? `${this.table}-${this.rows.length + i + 1}`, ...r }));
      this.rows.push(...withIds);
      return withIds;
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  then(resolve: (v: { data: Row[]; error: null }) => void) { resolve({ data: this.run(), error: null }); }
  async maybeSingle() { const hit = this.run(); return { data: hit[0] ?? null, error: null }; }
  async single() { const hit = this.run(); return hit[0] ? { data: hit[0], error: null } : { data: null, error: { message: 'no rows' } }; }
}

const world = () => {
  const tables: Record<string, Row[]> = {
    payment_vouchers: [{
      id: 'pv-1', pv_number: 'HC-PV-2608-001', company_id: CO, status: 'DRAFT',
      voucher_date: '2026-08-28', payee_name: 'Freight Co', credit_account_code: '330-0000',
      currency: 'MYR', exchange_rate: 1, purpose: 'EXPENSE', total_sen: 50_000,
      submitted_at: null, submitted_by: null, approved_at: null, approved_by: null,
    }],
    payment_voucher_lines: [],
    entity_audit_log: [],
    journal_entries: [],
  };
  return tables;
};

function makeApp(tables: Record<string, Row[]>, perms: string[]) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ??= []), t),
      schema() { return this; },
      rpc: async (fn: string) => (fn === 'entity_audit_writable' ? { data: true, error: null } : { data: null, error: { message: `unexpected rpc ${fn}` } }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(perms) } as never);
    await next();
  });
  app.post('/pv/:id/submit', submitPaymentVoucherHandler as never);
  app.post('/pv/:id/withdraw', withdrawPaymentVoucherHandler as never);
  app.post('/pv/:id/approve', approvePaymentVoucherHandler as never);
  app.post('/pv/:id/reject', rejectPaymentVoucherHandler as never);
  app.patch('/pv/:id', updatePaymentVoucherHandler as never);
  app.post('/pv/:id/post', postPaymentVoucherHandler as never);
  return app;
}

const WRITER = ['scm.payment_voucher.write', 'scm.payment_voucher.post'];
const APPROVER = [...WRITER, 'scm.payment_voucher.approve'];

let tables: Record<string, Row[]>;
beforeEach(() => { tables = world(); });

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });

describe('the cycle moves the marks and writes the trail', () => {
  test('submit stamps who and when; approve stamps the yes; post then passes the gate', async () => {
    const app = makeApp(tables, APPROVER);
    expect((await post(app, '/pv/pv-1/submit')).status).toBe(200);
    const pv = tables.payment_vouchers[0];
    expect(pv.submitted_by).toBe('Tester');
    expect(pv.submitted_at).toBeTruthy();

    expect((await post(app, '/pv/pv-1/approve')).status).toBe(200);
    expect(pv.approved_by).toBe('Tester');

    /* The gate passes — the handler then fails on this trimmed world's empty
       lines table, which is the assertion: the refusal is no_lines, no longer
       not_approved. */
    const res = await post(app, '/pv/pv-1/post');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('no_lines');

    const actions = tables.entity_audit_log.map((r) => r.action);
    expect(actions).toContain('SUBMIT_FOR_APPROVAL');
    expect(actions).toContain('APPROVE');
  });

  test('submitting twice is refused', async () => {
    const app = makeApp(tables, APPROVER);
    await post(app, '/pv/pv-1/submit');
    const res = await post(app, '/pv/pv-1/submit');
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('already_submitted');
  });
});

describe('the doors check the right keys', () => {
  test('a writer without the approve key is turned away from approve and reject', async () => {
    const app = makeApp(tables, WRITER);
    await post(app, '/pv/pv-1/submit');
    expect((await post(app, '/pv/pv-1/approve')).status).toBe(403);
    expect((await post(app, '/pv/pv-1/reject')).status).toBe(403);
  });
});

describe('frozen while queued', () => {
  test('editing a submitted voucher is refused with the withdraw sentence', async () => {
    const app = makeApp(tables, APPROVER);
    await post(app, '/pv/pv-1/submit');
    const res = await app.request('/pv/pv-1', {
      method: 'PATCH', body: JSON.stringify({ payeeName: 'Someone Else' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('awaiting_approval');
    expect(body.message).toMatch(/Withdraw it to edit/);
    expect(tables.payment_vouchers[0].payee_name).toBe('Freight Co');
  });
});

describe('the post gate', () => {
  test('an unapproved voucher cannot post — the fee for skipping the queue is a sentence, not money gone', async () => {
    const app = makeApp(tables, APPROVER);
    const res = await post(app, '/pv/pv-1/post');
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_approved');
  });
});

describe('coming back out of the queue', () => {
  test('withdraw clears both marks and the voucher is editable again', async () => {
    const app = makeApp(tables, APPROVER);
    await post(app, '/pv/pv-1/submit');
    await post(app, '/pv/pv-1/approve');
    expect((await post(app, '/pv/pv-1/withdraw')).status).toBe(200);
    const pv = tables.payment_vouchers[0];
    expect(pv.submitted_at).toBeNull();
    expect(pv.approved_at).toBeNull();
    const res = await app.request('/pv/pv-1', {
      method: 'PATCH', body: JSON.stringify({ payeeName: 'Corrected Payee' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(pv.payee_name).toBe('Corrected Payee');
  });

  test('reject clears the marks and carries its note onto the trail', async () => {
    const app = makeApp(tables, APPROVER);
    await post(app, '/pv/pv-1/submit');
    const res = await post(app, '/pv/pv-1/reject', { note: 'wrong payee — this is the freight forwarder, not the supplier' });
    expect(res.status).toBe(200);
    const pv = tables.payment_vouchers[0];
    expect(pv.submitted_at).toBeNull();
    const reject = tables.entity_audit_log.find((r) => r.action === 'REJECT');
    expect(JSON.stringify(reject)).toMatch(/wrong payee/);
  });
});
