// The owner's four layers through the ROUTES (2026-09-02) — the rule table
// is pv-approval.test.ts; what this file proves is what a pure function
// cannot:
//   · prepare / check / approve / withdraw / reject actually move the marks
//     on the row and each leaves an audit entry naming who;
//   · the check door wants scm.payment_voucher.check, the approve door
//     scm.payment_voucher.approve, and reject opens to EITHER key — a writer
//     holding neither is turned away;
//   · a PREPARED voucher still edits (the owner kept it so); a CHECKED one
//     is locked;
//   · APPROVE walks straight into the post door in the same request — the
//     approver's response is the post's own (here: this trimmed world's
//     no_lines), and approving again after a died post resumes WITHOUT
//     rewriting the first approval's stamp;
//   · the standalone POST door still refuses an unapproved voucher, and the
//     approve key alone opens it;
//   · a reject at either layer clears EVERY mark (一律退回 Draft) and
//     carries its note onto the trail.
//
// Same bare-Hono + fake-PostgREST harness as tests/pvRateFromPayment.test.ts,
// trimmed to the tables these handlers touch. NO vi.mock, deliberately.

import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  submitPaymentVoucherHandler, withdrawPaymentVoucherHandler,
  checkPaymentVoucherHandler, approvePaymentVoucherHandler,
  rejectPaymentVoucherHandler, updatePaymentVoucherHandler,
  postPaymentVoucherHandler,
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
      id: 'pv-1', pv_number: 'HC-PV-2609-001', company_id: CO, status: 'DRAFT',
      voucher_date: '2026-09-02', payee_name: 'Freight Co', credit_account_code: '330-0000',
      currency: 'MYR', exchange_rate: 1, purpose: 'EXPENSE', total_sen: 50_000,
      submitted_at: null, submitted_by: null, checked_at: null, checked_by: null,
      approved_at: null, approved_by: null,
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
  app.post('/pv/:id/check', checkPaymentVoucherHandler as never);
  app.post('/pv/:id/approve', approvePaymentVoucherHandler as never);
  app.post('/pv/:id/reject', rejectPaymentVoucherHandler as never);
  app.patch('/pv/:id', updatePaymentVoucherHandler as never);
  app.post('/pv/:id/post', postPaymentVoucherHandler as never);
  return app;
}

const WRITER = ['scm.payment_voucher.write'];
const CHECKER = [...WRITER, 'scm.payment_voucher.check'];
const FULL = [...CHECKER, 'scm.payment_voucher.approve'];

let tables: Record<string, Row[]>;
beforeEach(() => { tables = world(); });

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });

describe('the cycle moves the marks and writes the trail', () => {
  test('prepare stamps who; check stamps the first yes; approve stamps the second AND walks into post', async () => {
    const app = makeApp(tables, FULL);
    expect((await post(app, '/pv/pv-1/submit')).status).toBe(200);
    const pv = tables.payment_vouchers[0];
    expect(pv.submitted_by).toBe('Tester');
    expect(pv.submitted_at).toBeTruthy();

    expect((await post(app, '/pv/pv-1/check')).status).toBe(200);
    expect(pv.checked_by).toBe('Tester');
    expect(pv.checked_at).toBeTruthy();

    /* Approve = post in the same breath. This trimmed world has no lines, so
       the response is the POST handler's own refusal — which is exactly the
       proof that approval reached the post door without a second click. */
    const res = await post(app, '/pv/pv-1/approve');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('no_lines');
    expect(pv.approved_by).toBe('Tester');
    expect(pv.approved_at).toBeTruthy();

    /* The stamp survives a died post: approving again RESUMES (post door
       again, same refusal) and does not rewrite who said yes. */
    const firstYes = pv.approved_at;
    const again = await post(app, '/pv/pv-1/approve');
    expect(again.status).toBe(400);
    expect(pv.approved_at).toBe(firstYes);

    const actions = tables.entity_audit_log.map((r) => r.action);
    expect(actions).toContain('SUBMIT_FOR_APPROVAL');
    expect(actions).toContain('CHECK');
    /* One APPROVE only — the resume did not double-log the yes. */
    expect(actions.filter((a) => a === 'APPROVE')).toHaveLength(1);
  });

  test('preparing twice is refused; approving an unchecked voucher is refused with the first-yes sentence', async () => {
    const app = makeApp(tables, FULL);
    await post(app, '/pv/pv-1/submit');
    const twice = await post(app, '/pv/pv-1/submit');
    expect(twice.status).toBe(409);
    expect((await twice.json() as { error: string }).error).toBe('already_prepared');

    const early = await post(app, '/pv/pv-1/approve');
    expect(early.status).toBe(409);
    const body = await early.json() as { error: string; message: string };
    expect(body.error).toBe('not_checked');
    expect(body.message).toMatch(/first yes comes before yours/);
  });
});

describe('the doors check the right keys', () => {
  test('a plain writer is turned away from check, approve AND reject; a checker from approve', async () => {
    const writerApp = makeApp(tables, WRITER);
    await post(writerApp, '/pv/pv-1/submit');
    expect((await post(writerApp, '/pv/pv-1/check')).status).toBe(403);
    expect((await post(writerApp, '/pv/pv-1/approve')).status).toBe(403);
    expect((await post(writerApp, '/pv/pv-1/reject')).status).toBe(403);

    const checkerApp = makeApp(tables, CHECKER);
    expect((await post(checkerApp, '/pv/pv-1/check')).status).toBe(200);
    expect((await post(checkerApp, '/pv/pv-1/approve')).status).toBe(403);
    /* …but the checker MAY reject — either key opens that door. */
    expect((await post(checkerApp, '/pv/pv-1/reject')).status).toBe(200);
  });
});

describe('editability follows the first yes, not the queue', () => {
  test('a PREPARED voucher still edits — the owner kept it so', async () => {
    const app = makeApp(tables, FULL);
    await post(app, '/pv/pv-1/submit');
    const res = await app.request('/pv/pv-1', {
      method: 'PATCH', body: JSON.stringify({ payeeName: 'Corrected Payee' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(tables.payment_vouchers[0].payee_name).toBe('Corrected Payee');
  });

  test('a CHECKED voucher is locked, and the refusal says reject-back', async () => {
    const app = makeApp(tables, FULL);
    await post(app, '/pv/pv-1/submit');
    await post(app, '/pv/pv-1/check');
    const res = await app.request('/pv/pv-1', {
      method: 'PATCH', body: JSON.stringify({ payeeName: 'Someone Else' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('already_checked');
    expect(body.message).toMatch(/Reject it back to draft/);
    expect(tables.payment_vouchers[0].payee_name).toBe('Freight Co');
  });
});

describe('the standalone post door', () => {
  test('an unapproved voucher cannot post — a sentence, not money gone', async () => {
    const app = makeApp(tables, FULL);
    const res = await post(app, '/pv/pv-1/post');
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('not_approved');
  });

  test('the approve key alone opens the post door (approval IS the posting)', async () => {
    const app = makeApp(tables, [...WRITER, 'scm.payment_voucher.approve']);
    /* No scm.payment_voucher.post in the set — 409 (gate), not 403 (door). */
    const res = await post(app, '/pv/pv-1/post');
    expect(res.status).toBe(409);
  });
});

describe('coming back out of the cycle — 一律退回 Draft', () => {
  test('withdraw works while merely prepared, and is refused after the first yes', async () => {
    const app = makeApp(tables, FULL);
    await post(app, '/pv/pv-1/submit');
    expect((await post(app, '/pv/pv-1/withdraw')).status).toBe(200);
    expect(tables.payment_vouchers[0].submitted_at).toBeNull();

    await post(app, '/pv/pv-1/submit');
    await post(app, '/pv/pv-1/check');
    const late = await post(app, '/pv/pv-1/withdraw');
    expect(late.status).toBe(409);
    expect((await late.json() as { message: string }).message).toMatch(/only be rejected back/);
  });

  test('reject at the approve layer clears EVERY mark and carries its note onto the trail', async () => {
    const app = makeApp(tables, FULL);
    await post(app, '/pv/pv-1/submit');
    await post(app, '/pv/pv-1/check');
    const res = await post(app, '/pv/pv-1/reject', { note: 'wrong payee — this is the freight forwarder, not the supplier' });
    expect(res.status).toBe(200);
    const pv = tables.payment_vouchers[0];
    expect(pv.submitted_at).toBeNull();
    expect(pv.checked_at).toBeNull();
    expect(pv.checked_by).toBeNull();
    expect(pv.approved_at).toBeNull();
    const reject = tables.entity_audit_log.find((r) => r.action === 'REJECT');
    expect(JSON.stringify(reject)).toMatch(/wrong payee/);
  });
});
