/* The AP split's server-side authority (owner 2026-09-03): a 405-x supplier
   is an OTHER CREDITOR — its AP Payment debits AP_OTHER (405-0000), everyone
   else AP (400-0000). The page picks the right control (display mirror); THIS
   guard is the enforcement: a SUPPLIER_PAYMENT that debits the WRONG control
   refuses with `wrong_ap_control`, so an out-of-date client cannot book a 405
   supplier's debt into the trade-creditor control or vice versa.

   Same bare-Hono + fake-PostgREST-shaped harness as tests/pvVendorMemory.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';

type Row = Record<string, any>;
const CO = 2;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' = 'select';
  private inserted: Row[] = [];
  private rangeFrom: number | null = null;
  private rangeTo = 0;
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  like(col: string, pat: string) {
    const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`).replace(/%/g, '.*').replace(/_/g, '.')}$`);
    this.preds.push((r) => re.test(String(r[col] ?? '')));
    return this;
  }
  range(fromN: number, toN: number) { this.rangeFrom = fromN; this.rangeTo = toN; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  private run(): Row[] {
    if (this.op === 'insert') {
      const withIds = this.inserted.map((r, i) => ({ id: r.id ?? `${this.table}-${this.rows.length + i + 1}`, ...r }));
      this.rows.push(...withIds);
      return withIds;
    }
    let hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.rangeFrom != null) hit = hit.slice(this.rangeFrom, this.rangeTo + 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
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
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/payment-vouchers', createPaymentVoucherHandler as never);
  return app;
}

const tablesWith = (): Record<string, Row[]> => ({
  accounts: [
    { account_code: '310-0010', account_name: 'Bank', acc_money: true, is_active: true, company_id: CO },
    { account_code: '400-0000', account_name: 'AP', acc_money: false, is_active: true, company_id: CO },
    { account_code: '405-0000', account_name: 'Other Creditos', acc_money: false, is_active: true, company_id: CO },
  ],
  suppliers: [
    { id: 'sup-405', code: '405-Z002', name: 'ZHEJIANG JU MIAO', company_id: CO },
    { id: 'sup-400', code: '400-T005', name: 'TODERN HOME', company_id: CO },
  ],
  acc_account_roles: [],
});

const apBody = (supplierId: string, debit: string) => ({
  payeeName: 'whoever',
  purpose: 'SUPPLIER_PAYMENT',
  supplierId,
  currency: 'MYR',
  exchangeRate: 1,
  creditAccountCode: '310-0010',
  lines: [{ description: 'AP settlement', debitAccountCode: debit, amountSen: 15000 }],
});

describe('the AP split guard — wrong control refuses, right control saves', () => {
  test('a 405 supplier debiting 400-0000 is refused with the corrective sentence', async () => {
    const app = harness(tablesWith());
    const res = await app.request('/payment-vouchers', {
      method: 'POST', body: JSON.stringify(apBody('sup-405', '400-0000')),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('wrong_ap_control');
    expect(body.message).toMatch(/405-Z002 books to 405-0000/);
  });

  test('a trade supplier debiting 405-0000 is refused the mirror way', async () => {
    const app = harness(tablesWith());
    const res = await app.request('/payment-vouchers', {
      method: 'POST', body: JSON.stringify(apBody('sup-400', '405-0000')),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('wrong_ap_control');
  });

  test('each supplier saving onto ITS OWN control passes the guard', async () => {
    for (const [sup, debit] of [['sup-405', '405-0000'], ['sup-400', '400-0000']] as const) {
      const app = harness(tablesWith());
      const res = await app.request('/payment-vouchers', {
        method: 'POST', body: JSON.stringify(apBody(sup, debit)),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status, `${sup} → ${debit} should save; got ${await res.clone().text()}`).toBe(201);
    }
  });
});
