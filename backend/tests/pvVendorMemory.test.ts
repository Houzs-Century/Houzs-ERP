/* Vendor memory (mig 0341) — 我想要你要有记忆我下次submit 同个类型的invoice
 * 自动帮我填，选account 等等 (the owner, 2026-09-02). What is pinned:
 *
 *   • saving a plain (expense) voucher teaches: payee casing, the FIRST
 *     line's account, the purpose — keyed by normalizeVendor, last-saved-wins,
 *     times_seen only grows;
 *   • an AP payment teaches NOTHING (its line debits the AP control, fixed by
 *     role);
 *   • a DRAFT edit that replaces the lines re-teaches — the correction signal;
 *   • POST /payment-vouchers/extract hands the habit back: the printed name
 *     first, the matched supplier's name as fallback, null when unknown.
 *
 * Same bare-Hono + fake-PostgREST harness as tests/pvSupplierAdvance.test.ts;
 * the Anthropic call is a stubbed global fetch returning a canned reading.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createPaymentVoucherHandler, updatePaymentVoucherHandler, extractBillsHandler,
} from '../src/scm/routes/payment-vouchers';

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
  range() { return this; }
  like() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  /* Conflict-key hit updates in place, miss inserts — the fake-postgrest rule. */
  upsert(p: Row | Row[], opts?: { onConflict?: string }) {
    const rows = Array.isArray(p) ? p : [p];
    const keys = (opts?.onConflict ?? 'id').split(',').map((s) => s.trim());
    for (const r of rows) {
      const hit = this.rows.find((ex) => keys.every((k) => String(ex[k]) === String(r[k])));
      if (hit) Object.assign(hit, r); else this.rows.push({ ...r });
    }
    this.preds.push(() => false);
    return this;
  }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  is() { return this; }
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
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, opts?: { poisonMemory?: boolean }) {
  const app = new Hono();
  const counters = new Map<string, number>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => {
        /* A client that THROWS on the memory table — the harness for "a habit
           cache must never turn a saved voucher into an error". */
        if (opts?.poisonMemory && t === 'acc_vendor_memory') {
          return { select() { return this; }, eq() { return this; }, maybeSingle() { throw new TypeError('boom'); } };
        }
        return new FakeQuery((tables[t] ||= []), t);
      },
      schema(_s: string) { return this; },
      rpc: async (fn: string, args: Row) => {
        if (fn === 'entity_audit_writable') return { data: true, error: null };
        if (fn === 'next_doc_no_n') {
          const series = String(args.p_series);
          const floor = Math.max(0, Number(args.p_floor ?? 0));
          const n = Math.max(counters.get(series) ?? 0, floor + 1);
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
  app.patch('/payment-vouchers/:id', updatePaymentVoucherHandler as never);
  app.post('/payment-vouchers/extract', extractBillsHandler as never);
  return app;
}

const createBody = (over: Row = {}) => ({
  payeeName: 'Tenaga Nasional Berhad',
  purpose: 'OTHER',
  currency: 'MYR',
  exchangeRate: 1,
  creditAccountCode: '330-0000',
  lines: [{ description: 'September electricity', debitAccountCode: '900-U001', amountSen: 15000 }],
  ...over,
});

describe('saving a plain voucher teaches the vendor habit', () => {
  test('first save writes the row; a re-save is last-saved-wins and times_seen grows', async () => {
    const tables: Record<string, Row[]> = {
      accounts: [{ account_code: '330-0000', account_name: 'Bank', acc_money: true, is_active: true, company_id: CO }],
    };
    const app = harness(tables);

    const r1 = await app.request('/payment-vouchers', {
      method: 'POST', body: JSON.stringify(createBody()), headers: { 'content-type': 'application/json' },
    });
    expect(r1.status).toBe(201);
    expect(tables.acc_vendor_memory).toHaveLength(1);
    expect(tables.acc_vendor_memory![0]).toMatchObject({
      company_id: CO,
      vendor_key: 'TENAGA NASIONAL BERHAD',
      payee_name: 'Tenaga Nasional Berhad',
      debit_account_code: '900-U001',
      purpose: 'OTHER',
      times_seen: 1,
    });

    /* The operator picks a DIFFERENT account next month — the habit follows
       the human, and the counter shows the habit is settled, not a one-off. */
    const r2 = await app.request('/payment-vouchers', {
      method: 'POST',
      body: JSON.stringify(createBody({ lines: [{ description: 'October electricity', debitAccountCode: '900-U009', amountSen: 16000 }] })),
      headers: { 'content-type': 'application/json' },
    });
    expect(r2.status).toBe(201);
    expect(tables.acc_vendor_memory).toHaveLength(1);
    expect(tables.acc_vendor_memory![0]).toMatchObject({ debit_account_code: '900-U009', times_seen: 2 });
  });

  test('an AP payment teaches nothing — its account is the AP control, fixed by role', async () => {
    const tables: Record<string, Row[]> = {
      accounts: [{ account_code: '330-0000', account_name: 'Bank', acc_money: true, is_active: true, company_id: CO }],
    };
    const app = harness(tables);
    const res = await app.request('/payment-vouchers', {
      method: 'POST',
      body: JSON.stringify(createBody({
        purpose: 'SUPPLIER_PAYMENT', supplierId: 'sup-1',
        lines: [{ description: 'Settlement', debitAccountCode: '400-0000', amountSen: 15000 }],
      })),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    expect(tables.acc_vendor_memory ?? []).toHaveLength(0);
  });

  test('a memory client that THROWS still saves the voucher — best-effort means best-effort', async () => {
    const tables: Record<string, Row[]> = {
      accounts: [{ account_code: '330-0000', account_name: 'Bank', acc_money: true, is_active: true, company_id: CO }],
    };
    const app = harness(tables, { poisonMemory: true });
    const res = await app.request('/payment-vouchers', {
      method: 'POST', body: JSON.stringify(createBody()), headers: { 'content-type': 'application/json' },
    });
    /* The voucher already stood when the habit write blew up — 201, not 500.
       (Found the hard way: a harness without upsert 500'd every create.) */
    expect(res.status).toBe(201);
  });

  test('a DRAFT edit that replaces the lines re-teaches — the correction signal', async () => {
    const tables: Record<string, Row[]> = {
      payment_vouchers: [{
        id: 'pv-1', pv_number: 'PV-2609-001', status: 'DRAFT', company_id: CO,
        payee_name: 'Tenaga Nasional Berhad', purpose: 'OTHER', currency: 'MYR',
        exchange_rate: 1, total_sen: 15000, voucher_date: '2026-09-01',
        submitted_at: null, approved_at: null,
      }],
      payment_voucher_lines: [{ id: 'l1', pv_id: 'pv-1', line_no: 1, debit_account_code: '900-U001', amount_sen: 15000 }],
    };
    const app = harness(tables);
    const res = await app.request('/payment-vouchers/pv-1', {
      method: 'PATCH',
      body: JSON.stringify({ lines: [{ description: 'fixed', debitAccountCode: '900-U777', amountSen: 15000 }] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(tables.acc_vendor_memory![0]).toMatchObject({
      vendor_key: 'TENAGA NASIONAL BERHAD', debit_account_code: '900-U777', times_seen: 1,
    });
  });
});

/* ── The reader hands the habit back ────────────────────────────────────── */

const anthropicAnswer = (bill: Row) => new Response(JSON.stringify({
  content: [{ type: 'text', text: JSON.stringify(bill) }],
}), { status: 200 });

const readBill = (vendorName: string) => ({
  vendorName, vendorRegNo: null, documentKind: 'bill', invoiceNumber: 'INV-9',
  invoiceDate: '2026-09-01', dueDate: null, currency: 'MYR', totalRm: '150.00', sstRm: null, lines: [],
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('POST /extract carries the memory', () => {
  test('printed-name hit, matched-supplier fallback, and null when unknown', async () => {
    const bills = [readBill('Tenaga Nasional Berhad'), readBill('Hookka Furniture Sdn Bhd'), readBill('Never Seen Trading')];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(bills[call++]!)));

    const tables: Record<string, Row[]> = {
      suppliers: [{ id: 'sup-1', code: 'S001', name: 'Hookka Furniture', status: 'ACTIVE', company_id: CO }],
      acc_vendor_memory: [
        /* Saved under the printed name once… */
        { company_id: CO, vendor_key: 'TENAGA NASIONAL BERHAD', payee_name: 'Tenaga Nasional Berhad', debit_account_code: '900-U001', purpose: 'OTHER', times_seen: 3 },
        /* …and under the SUPPLIER's clean name — the bill's SDN BHD tail
           normalizes away and the matcher's answer finds it. */
        { company_id: CO, vendor_key: 'HOOKKA FURNITURE', payee_name: 'Hookka Furniture', debit_account_code: '900-F002', purpose: 'OTHER', times_seen: 5 },
        /* The other company's habit must NOT leak. */
        { company_id: 2, vendor_key: 'NEVER SEEN', payee_name: 'Never Seen', debit_account_code: '999-X001', purpose: 'OTHER', times_seen: 9 },
      ],
    };
    const app = harness(tables);
    const res = await app.request('/payment-vouchers/extract', {
      method: 'POST',
      body: JSON.stringify({ bills: bills.map(() => ({ files: [{ name: 'a.jpg', mime: 'image/jpeg', dataBase64: 'aGk=' }] })) }),
      headers: { 'content-type': 'application/json' },
    }, { ANTHROPIC_API_KEY: 'k' } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { bills: Array<Row> };

    expect(body.bills[0]!.memory).toMatchObject({ debitAccountCode: '900-U001', payeeName: 'Tenaga Nasional Berhad', timesSeen: 3 });
    expect(body.bills[1]!.supplierMatch).toMatchObject({ id: 'sup-1' });
    expect(body.bills[1]!.memory).toMatchObject({ debitAccountCode: '900-F002' });
    expect(body.bills[2]!.supplierMatch).toBeNull();
    expect(body.bills[2]!.memory).toBeNull();
  });
});
