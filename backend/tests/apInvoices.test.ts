/* AP Invoices — the non-stock supplier bill (owner 2026-09-06, AutoCount in
   hand). Pinned:
     • the Finance list shows BOTH kinds — purchase invoices as a read-only
       mirror beside the AP invoices raised here — one table, a `kind`;
     • create mints {co}API-YYMM-NNN and refuses a header / control account
       on a line (父户不记账, 由模块过账) and a foreign currency (first cut);
     • post books Dr each line's own account / Cr the supplier's AP control
       (405 for a 405-x supplier) through the ONE gate, once — a second post
       echoes; cancel writes the contra and refuses a bill with money on it;
     • an AP Payment allocation may name an AP invoice instead of a PI, the
       post settles it through the twin clamp and cancel unwinds it.
   Same fake-PostgREST harness as tests/officialReceipts.test.ts for the
   routes; the PV half copies tests/pvSupplierAdvance.test.ts's harness. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { computePiSettlement } from '../src/scm/lib/pi-settlement';
import { apInvoices } from '../src/scm/routes/ap-invoices';
import { buildAllocations, postPaymentVoucherHandler, cancelPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';

const CO = 2;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

/* BILL.invoiceDate is 2026-09-01 — a number follows its DOCUMENT date, never
   the day it was keyed (owner 2026-09-07). */
const yymm = '2609';

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('900-0000', 'Operating Expense', 'EXPENSE'),
  acct('900-A001', 'RENTAL', 'EXPENSE', { parent_code: '900-0000' }),
  acct('900-A002', 'SERVICE FEE', 'EXPENSE', { parent_code: '900-0000' }),
  acct('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY', { special_type: 'SCC' }),
  acct('405-0000', 'OTHER CREDITORS', 'LIABILITY', { special_type: 'SCC' }),
  acct('310-0010', 'MAYBANK', 'ASSET', { acc_money: true }),
];
const SUPPLIERS: Row[] = [
  { id: 'sup-h', company_id: CO, code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
  { id: 'sup-t', company_id: CO, code: '400-T005', name: 'TODERN' },
];

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = PV_KEYS) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    suppliers: SUPPLIERS.map((r) => ({ ...r })),
    companies: [{ id: CO, code: '2990' }],
    acc_account_roles: [],
    ap_invoices: [],
    ap_invoice_lines: [],
    journal_entries: [],
    journal_entry_lines: [],
    purchase_invoices: [],
    ...tables,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    /* The router carries the supabaseAuth bridge (docs/bugs/0648). The pinned
       system-staff id is the bridge's own "already translated" mark, so it steps
       aside and the supabase + houzsUser set by hand below stay in force. */
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.route('/ap-invoices', apInvoices);
  return { app, sb };
}

const json = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const BILL = {
  supplierId: 'sup-h', supplierInvoiceRef: 'HVH-0912', invoiceDate: '2026-09-01', dueDate: '2026-09-30',
  lines: [
    { description: 'Rent Sept', debitAccountCode: '900-A001', amountSen: 400_000 },
    { description: 'Cleaning', debitAccountCode: '900-A002', amountSen: 20_000 },
  ],
};

describe('raising an AP invoice', () => {
  test('mints {co}API-YYMM-NNN, stores the lines, totals them, stays DRAFT', async () => {
    const { app, sb } = harness();
    const res = await json(app, '/ap-invoices', 'POST', BILL);
    expect(res.status).toBe(201);
    const b = await res.json() as { invoice: Row };
    expect(b.invoice.invoice_number).toBe(`2990-API-${yymm}-001`);
    expect(b.invoice).toMatchObject({ status: 'DRAFT', total_sen: 420_000, paid_sen: 0, supplier_id: 'sup-h' });
    expect(sb.tables.ap_invoice_lines).toHaveLength(2);
    /* No journal yet — a draft is not a liability. */
    expect(sb.tables.journal_entries).toHaveLength(0);
  });

  test('a header account, a control account and a foreign currency are refused by name', async () => {
    const { app } = harness();
    const header = await json(app, '/ap-invoices', 'POST', { ...BILL, lines: [{ debitAccountCode: '900-0000', amountSen: 100 }] });
    expect(header.status).toBeGreaterThanOrEqual(400);
    expect((await header.json() as { error: string }).error).toBe('not_a_leaf_account');
    const control = await json(app, '/ap-invoices', 'POST', { ...BILL, lines: [{ debitAccountCode: '400-0000', amountSen: 100 }] });
    expect(control.status).toBeGreaterThanOrEqual(400);
    expect((await control.json() as { error: string }).error).toBe('control_account_locked');
    const fx = await json(app, '/ap-invoices', 'POST', { ...BILL, currency: 'USD' });
    expect(fx.status).toBe(400);
    expect((await fx.json() as { error: string }).error).toBe('currency_unsupported');
  });

  test('a save teaches vendor memory: the supplier → the first line\'s account, so the next scan of the same vendor pre-fills it', async () => {
    const { app, sb } = harness({ acc_vendor_memory: [] });
    expect((await json(app, '/ap-invoices', 'POST', BILL)).status).toBe(201);
    expect(sb.tables.acc_vendor_memory).toHaveLength(1);
    expect(sb.tables.acc_vendor_memory[0]).toMatchObject({
      company_id: CO, payee_name: 'HOUZS VENTURE HOLDING SDN BHD', debit_account_code: '900-A001', purpose: 'SUPPLIER_PAYMENT', times_seen: 1,
    });
    expect(String(sb.tables.acc_vendor_memory[0]!.vendor_key)).not.toBe('');
    /* The habit is last-saved-wins; times_seen only grows. */
    await json(app, '/ap-invoices', 'POST', { ...BILL, lines: [{ debitAccountCode: '900-A002', amountSen: 5_000 }] });
    expect(sb.tables.acc_vendor_memory).toHaveLength(1);
    expect(sb.tables.acc_vendor_memory[0]).toMatchObject({ debit_account_code: '900-A002', times_seen: 2 });
  });
});

describe('posting and cancelling', () => {
  test('post books Dr each line / Cr 405 for a 405-x supplier, once; cancel writes the contra', async () => {
    const { app, sb } = harness();
    const created = await (await json(app, '/ap-invoices', 'POST', BILL)).json() as { invoice: Row };
    const id = created.invoice.id;
    const post = await json(app, `/ap-invoices/${id}/post`, 'POST');
    expect(post.status).toBe(200);
    const je = sb.tables.journal_entries.find((j) => j.source_type === 'API')!;
    expect(je).toMatchObject({ source_doc_no: `2990-API-${yymm}-001`, entry_date: '2026-09-01', posted: true });
    const lines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === je.id);
    expect(lines.map((l) => [l.account_code, Number(l.debit_sen), Number(l.credit_sen)])).toEqual([
      ['900-A001', 400_000, 0], ['900-A002', 20_000, 0], ['405-0000', 0, 420_000],
    ]);
    expect(lines[2]).toMatchObject({ party_type: 'SUPPLIER', party_code: '405-H001' });
    expect(sb.tables.ap_invoices[0]).toMatchObject({ status: 'POSTED' });
    /* A second post echoes — one active entry per document. */
    const again = await json(app, `/ap-invoices/${id}/post`, 'POST');
    expect(again.status).toBe(200);
    expect((await again.json() as { status: string }).status).toBe('already_posted');
    expect(sb.tables.journal_entries.filter((j) => j.source_type === 'API')).toHaveLength(1);

    const cancel = await json(app, `/ap-invoices/${id}/cancel`, 'POST');
    expect(cancel.status).toBe(200);
    expect(sb.tables.journal_entries.some((j) => j.source_type === 'API_REVERSAL')).toBe(true);
    expect(sb.tables.ap_invoices[0]).toMatchObject({ status: 'CANCELLED' });
  });

  test('a 400-x supplier credits the trade control; a bill with money on it refuses to cancel', async () => {
    const { app, sb } = harness();
    const created = await (await json(app, '/ap-invoices', 'POST', { ...BILL, supplierId: 'sup-t' })).json() as { invoice: Row };
    await json(app, `/ap-invoices/${created.invoice.id}/post`, 'POST');
    const je = sb.tables.journal_entries.find((j) => j.source_type === 'API')!;
    const cr = sb.tables.journal_entry_lines.find((l) => l.journal_entry_id === je.id && Number(l.credit_sen) > 0)!;
    expect(cr.account_code).toBe('400-0000');
    sb.tables.ap_invoices[0]!.paid_sen = 100_000;
    const cancel = await json(app, `/ap-invoices/${created.invoice.id}/cancel`, 'POST');
    expect(cancel.status).toBe(409);
    expect((await cancel.json() as { error: string }).error).toBe('has_payments');
  });
});

describe('the Finance list — both kinds', () => {
  test('purchase invoices mirror beside the AP invoices, each with its kind and outstanding', async () => {
    const { app } = harness({
      purchase_invoices: [
        { id: 'pi-1', company_id: CO, invoice_number: '2990-PI-2607-005', supplier_invoice_ref: null, supplier_id: 'sup-t', invoice_date: '2026-07-01', due_date: '2026-07-31', currency: 'MYR', total_sen: 300_000, paid_sen: 100_000, status: 'PARTIALLY_PAID' },
        { id: 'pi-d', company_id: CO, invoice_number: '2990-PI-2609-099', supplier_invoice_ref: null, supplier_id: 'sup-t', invoice_date: '2026-09-05', due_date: null, currency: 'MYR', total_sen: 1, paid_sen: 0, status: 'DRAFT' },
      ],
      ap_invoices: [
        { id: 'api-1', company_id: CO, invoice_number: `2990-API-${yymm}-001`, supplier_id: 'sup-h', supplier_invoice_ref: 'HVH-0912', invoice_date: '2026-09-01', due_date: null, currency: 'MYR', exchange_rate: 1, total_sen: 420_000, paid_sen: 0, status: 'POSTED' },
      ],
    });
    const res = await app.request('/ap-invoices');
    expect(res.status).toBe(200);
    const b = await res.json() as { rows: Array<Row> };
    expect(b.rows.map((r) => [r.kind, r.invoiceNumber, r.outstandingSen])).toEqual([
      ['API', `2990-API-${yymm}-001`, 420_000],
      ['PI', '2990-PI-2607-005', 200_000],
    ]);
    /* Filtered to one kind on request. */
    const only = await (await app.request('/ap-invoices?kind=PI')).json() as { rows: Array<Row> };
    expect(only.rows.map((r) => r.kind)).toEqual(['PI']);
  });
});

describe('an AP Payment allocation may name an AP invoice', () => {
  test('buildAllocations: one target per row, either kind', () => {
    const ok = buildAllocations([{ apInvoiceId: 'api-1', amountSen: 100 }, { piId: 'pi-1', amountSen: 50 }]);
    expect(ok).toEqual({ rows: [
      { pi_id: null, ap_invoice_id: 'api-1', amount_sen: 100 },
      { pi_id: 'pi-1', ap_invoice_id: null, amount_sen: 50 },
    ], total: 150 });
    expect(buildAllocations([{ piId: 'pi-1', apInvoiceId: 'api-1', amountSen: 1 }])).toEqual({ error: 'allocation_two_targets' });
    expect(buildAllocations([{ amountSen: 1 }])).toEqual({ error: 'allocation_pi_required' });
  });

  /* The PV half — tests/pvSupplierAdvance.test.ts's harness, with the twin
     settle rpc answering for AP invoices the way the PI one does. */
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
    update(p: Row) { this.op = 'update'; this.patch = p; return this; }
    delete() { this.op = 'delete'; return this; }
    insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
    eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
    neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
    in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
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
    single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
    then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
  }

  function pvHarness(tables: Record<string, Row[]>) {
    const app = new Hono();
    const counters = new Map<string, number>();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, {
        from: (t: string) => new FakeQuery((tables[t] ||= []), t),
        schema(_s: string) { return this; },
        rpc: async (fn: string, args: Row) => {
          if (fn === 'entity_audit_writable') return { data: true, error: null };
          if (fn === 'settle_api_paid_sen') {
            const inv = (tables.ap_invoices ?? []).find((p) => p.id === args.p_id);
            if (!inv) return { data: [{ applied_sen: 0, reason: 'not_found' }], error: null };
            const calc = computePiSettlement({ paidSen: Number(inv.paid_sen ?? 0), totalSen: Number(inv.total_sen ?? 0), status: inv.status, deltaSen: Number(args.p_delta ?? 0) });
            if (!calc.skipped) { inv.paid_sen = calc.newPaidSen; inv.status = calc.newStatus; }
            return { data: [{ applied_sen: calc.skipped ? 0 : calc.appliedSen, new_paid_sen: inv.paid_sen, new_status: inv.status }], error: null };
          }
          if (fn === 'next_doc_no_n') {
            const series = String(args.p_series);
            const n = Math.max(counters.get(series) ?? 0, Math.max(0, Number(args.p_floor ?? 0)) + 1);
            counters.set(series, n + 1);
            return { data: n, error: null };
          }
          return { data: null, error: { message: `unexpected rpc ${fn}` } };
        },
      } as never);
      c.set('companyId' as never, 1 as never);
      c.set('user' as never, { id: 'u1' } as never);
      c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
      await next();
    });
    app.post('/payment-vouchers/:id/post', postPaymentVoucherHandler as never);
    app.post('/payment-vouchers/:id/cancel', cancelPaymentVoucherHandler as never);
    return app;
  }

  test('post settles the AP invoice through the twin clamp; cancel unwinds exactly what was applied', async () => {
    const tables: Record<string, Row[]> = {
      payment_vouchers: [{
        id: 'pv-1', pv_number: 'HC-PV-2609-001', company_id: 1, status: 'DRAFT',
        voucher_date: '2026-09-06', payee_name: 'HOUZS VENTURE', supplier_id: 'sup-h',
        credit_account_code: '1000', currency: 'MYR', exchange_rate: 1,
        purpose: 'SUPPLIER_PAYMENT', total_sen: 420_000,
        submitted_at: '2026-09-06T01:00:00Z', submitted_by: 'Tester',
        approved_at: '2026-09-06T02:00:00Z', approved_by: 'Tester',
      }],
      payment_voucher_lines: [{ id: 'pvl-1', pv_id: 'pv-1', line_no: 1, description: 'Settle rent', debit_account_code: '405-0000', amount_sen: 420_000 }],
      pv_allocations: [{ id: 'alloc-1', pv_id: 'pv-1', pi_id: null, ap_invoice_id: 'api-1', amount_sen: 420_000, applied_sen: 0, from_advance: false }],
      ap_invoices: [{ id: 'api-1', company_id: 1, invoice_number: 'API-2609-001', status: 'POSTED', total_sen: 420_000, paid_sen: 0 }],
      purchase_invoices: [], acc_supplier_advances: [],
      journal_entries: [], journal_entry_lines: [], entity_audit_log: [], suppliers: [],
    };
    const app = pvHarness(tables);
    const res = await app.request('/payment-vouchers/pv-1/post', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(tables.ap_invoices[0]).toMatchObject({ paid_sen: 420_000, status: 'PAID' });
    expect(tables.pv_allocations[0]).toMatchObject({ applied_sen: 420_000 });
    /* Exactly paid — nothing recorded as an advance. */
    expect(tables.acc_supplier_advances).toHaveLength(0);

    const cancel = await app.request('/payment-vouchers/pv-1/cancel', { method: 'POST' });
    expect(cancel.status).toBe(200);
    expect(tables.ap_invoices[0]).toMatchObject({ paid_sen: 0, status: 'POSTED' });
  });
});

describe('the number follows the document date (owner 2026-09-07: 要根据文件日期)', () => {
  test('a bill dated 31/03/2026 mints into the MARCH series whatever today is', async () => {
    const { app } = harness();
    const res = await json(app, '/ap-invoices', 'POST', { ...BILL, invoiceDate: '2026-03-31', dueDate: '2026-04-30' });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as { invoice: Row }).invoice.invoice_number).toBe('2990-API-2603-001');
  });
});
