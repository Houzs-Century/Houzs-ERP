/* docs/bugs/0653 — an allocation reserves its invoice the moment the voucher
   is saved, but paid_sen moves only at Approve. Pinned here:
     • GET /reservations/list sums what UNPOSTED vouchers applied per invoice,
       names the holders, skips posted vouchers and advance applications, and
       leaves out the voucher being edited (excludePvId);
     • the create door refuses an allocation beyond what is left
       (over_allocation, 409, holder named) — RED on the unfixed tree, where a
       second voucher could apply the same bill (owner 2026-09-07: HPV-2604-006
       had applied API-2603-001 and the picker still offered it in full).
   Same bare-Hono + fake-PostgREST harness as tests/pvApControlGuard.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';
import { pendingReservationsHandler } from '../src/scm/lib/pv-reservations';

type Row = Record<string, any>;
const CO = 2;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private inserted: Row[] = [];
  private patch: Row = {};
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  like() { return this; }
  is() { return this; }
  range() { return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
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
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  const counters = new Map<string, number>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema(_s: string) { return this; },
      rpc: async (fn: string, args: Row) => {
        if (fn === 'entity_audit_writable') return { data: true, error: null };
        if (fn === 'next_doc_no_n') {
          const series = String(args.p_series);
          const n = Math.max(counters.get(series) ?? 0, Math.max(0, Number(args.p_floor ?? 0)) + 1);
          counters.set(series, n + 1);
          return { data: n, error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      },
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/payment-vouchers', createPaymentVoucherHandler as never);
  app.get('/payment-vouchers/reservations/list', pendingReservationsHandler as never);
  return app;
}

/* HOUZS VENTURE (405) has one AP invoice; HPV-2604-006 — checked, NOT approved —
   already applies all of it. A trade supplier has a PI with nothing pending. */
const world = (): Record<string, Row[]> => ({
  accounts: [
    { account_code: '310-0010', account_name: 'Bank', acc_money: true, is_active: true, company_id: CO },
    { account_code: '400-0000', account_name: 'AP', acc_money: false, is_active: true, company_id: CO, special_type: 'SCC' },
    { account_code: '405-0000', account_name: 'Other Creditors', acc_money: false, is_active: true, company_id: CO, special_type: 'SCC' },
  ],
  suppliers: [
    { id: 'sup-h', code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD', company_id: CO },
    { id: 'sup-t', code: '400-T005', name: 'TODERN HOME', company_id: CO },
  ],
  acc_account_roles: [],
  ap_invoices: [
    { id: 'api-1', company_id: CO, invoice_number: '2990-API-2603-001', supplier_id: 'sup-h', total_sen: 214374, paid_sen: 0, status: 'POSTED' },
  ],
  purchase_invoices: [
    { id: 'pi-1', company_id: CO, invoice_number: '2990-PI-2609-001', supplier_id: 'sup-t', total_sen: 100000, paid_sen: 0, status: 'POSTED' },
  ],
  payment_vouchers: [
    { id: 'pv-checked', company_id: CO, pv_number: '2990-HPV-2604-006', supplier_id: 'sup-h', status: 'DRAFT', checked_at: '2026-09-07T03:46:56Z', total_sen: 214374 },
    { id: 'pv-posted', company_id: CO, pv_number: '2990-HPV-2608-001', supplier_id: 'sup-t', status: 'POSTED', total_sen: 30000 },
    { id: 'pv-adv', company_id: CO, pv_number: '2990-HPV-2608-002', supplier_id: 'sup-h', status: 'DRAFT', total_sen: 1000 },
  ],
  pv_allocations: [
    { id: 'al-1', company_id: CO, pv_id: 'pv-checked', pi_id: null, ap_invoice_id: 'api-1', amount_sen: 214374, applied_sen: 0, from_advance: false },
    /* Posted: its paid_sen already moved — not pending. */
    { id: 'al-2', company_id: CO, pv_id: 'pv-posted', pi_id: 'pi-1', ap_invoice_id: null, amount_sen: 30000, applied_sen: 30000, from_advance: false },
    /* An advance application settled paid_sen when applied — not pending. */
    { id: 'al-3', company_id: CO, pv_id: 'pv-adv', pi_id: null, ap_invoice_id: 'api-1', amount_sen: 1000, applied_sen: 1000, from_advance: true },
  ],
  pv_lines: [],
  payment_voucher_lines: [],
});

const apBody = (supplierId: string, debit: string, amountSen: number, allocations: unknown[]) => ({
  payeeName: 'whoever', purpose: 'SUPPLIER_PAYMENT', supplierId, currency: 'MYR', exchangeRate: 1,
  creditAccountCode: '310-0010',
  lines: [{ description: 'AP settlement', debitAccountCode: debit, amountSen }],
  allocations,
});
const send = (app: Hono, body: unknown) => app.request('/payment-vouchers', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});

describe('GET /payment-vouchers/reservations/list', () => {
  test('sums what UNPOSTED vouchers applied, names the holder, skips posted and advance rows, leaves the edited voucher out', async () => {
    const app = harness(world());
    const res = await app.request('/payment-vouchers/reservations/list?supplierId=sup-h');
    expect(res.status).toBe(200);
    const body = await res.json() as { byPi: Record<string, number>; byApInvoice: Record<string, number>; holders: Record<string, string[]> };
    expect(body.byApInvoice).toEqual({ 'api-1': 214374 });
    expect(body.byPi).toEqual({});
    expect(body.holders).toEqual({ 'api-1': ['2990-HPV-2604-006'] });

    const all = await app.request('/payment-vouchers/reservations/list');
    expect((await all.json() as { byPi: Record<string, number> }).byPi).toEqual({}); // pv-posted's PI row is settled, not pending

    const editing = await app.request('/payment-vouchers/reservations/list?supplierId=sup-h&excludePvId=pv-checked');
    expect((await editing.json() as { byApInvoice: Record<string, number> }).byApInvoice).toEqual({});
  });
});

describe('the create door and the headroom (docs/bugs/0653)', () => {
  test('a second voucher applying an invoice another unapproved voucher already holds is refused, holder named', async () => {
    const app = harness(world());
    const res = await send(app, apBody('sup-h', '405-0000', 214374, [{ apInvoiceId: 'api-1', amountSen: 214374 }]));
    expect(res.status, await res.clone().text()).toBe(409);
    const body = await res.json() as { error: string; message: string; leftSen: number };
    expect(body.error).toBe('over_allocation');
    expect(body.leftSen).toBe(0);
    expect(body.message).toMatch(/2990-API-2603-001: only RM 0\.00 is left to apply — 2990-HPV-2604-006 already applies RM 2,?143\.74/);
  });

  test('an invoice nobody else holds still takes an allocation up to its outstanding', async () => {
    const app = harness(world());
    const ok = await send(app, apBody('sup-t', '400-0000', 60000, [{ piId: 'pi-1', amountSen: 60000 }]));
    expect(ok.status, await ok.clone().text()).toBe(201);
    const over = await send(app, apBody('sup-t', '400-0000', 100001, [{ piId: 'pi-1', amountSen: 100001 }]));
    expect(over.status).toBe(409);
    expect((await over.json() as { error: string }).error).toBe('over_allocation');
  });
});
