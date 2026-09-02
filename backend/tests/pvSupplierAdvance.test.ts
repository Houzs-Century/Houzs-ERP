/* 预付挂在 supplier — the owner's own design (2026-08-30: 预付就不能直接挂在
 * supplier 那边吗?). What is pinned:
 *
 *   • posting a supplier voucher that pays MORE than its allocations records
 *     the excess as that supplier's advance — one row, on the voucher that
 *     paid ahead; an exact payment records nothing;
 *   • applying the advance settles real invoices with the SAME DB-clamped
 *     rule a payment uses, burns applied_sen by what actually landed, and
 *     posts NO journal — both legs already live in AP;
 *   • the money cannot be spent twice (Σ ≤ remaining, refused by name), and a
 *     voucher whose advance HAS been spent refuses to cancel;
 *   • an unspent advance cancels with its voucher, row and all.
 *
 * Same bare-Hono + fake-PostgREST harness as tests/pvRateFromPayment.test.ts
 * (its header carries the reasoning); settle_pi_paid_sen runs the REAL clamp
 * rule via computePiSettlement, so applied figures are production's.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { computePiSettlement } from '../src/scm/lib/pi-settlement';
import {
  postPaymentVoucherHandler, cancelPaymentVoucherHandler,
  applyAdvanceHandler, supplierAdvancesHandler,
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
  like() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
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

function harness(tables: Record<string, Row[]>) {
  const app = new Hono();
  const counters = new Map<string, number>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t),
      schema(_s: string) { return this; },
      rpc: async (fn: string, args: Row) => {
        if (fn === 'entity_audit_writable') return { data: true, error: null };
        if (fn === 'settle_pi_paid_sen') {
          const pi = (tables.purchase_invoices ?? []).find((p) => p.id === args.p_pi_id);
          if (!pi) return { data: [{ applied_sen: 0, reason: 'not_found' }], error: null };
          const calc = computePiSettlement({
            paidSen: Number(pi.paid_sen ?? 0),
            totalSen: Number(pi.total_sen ?? 0),
            status: pi.status,
            deltaSen: Number(args.p_delta ?? 0),
          });
          if (!calc.skipped) { pi.paid_sen = calc.newPaidSen; pi.status = calc.newStatus; }
          return {
            data: [{ applied_sen: calc.skipped ? 0 : calc.appliedSen, new_paid_sen: pi.paid_sen, new_status: pi.status }],
            error: null,
          };
        }
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
  app.post('/payment-vouchers/:id/post', postPaymentVoucherHandler as never);
  app.post('/payment-vouchers/:id/cancel', cancelPaymentVoucherHandler as never);
  app.post('/payment-vouchers/:id/apply-advance', applyAdvanceHandler as never);
  app.get('/payment-vouchers/advances/list', supplierAdvancesHandler as never);
  return app;
}

/* One supplier, one posted invoice of RM 2,000 outstanding, one approved MYR
   voucher of RM 5,000 whose only allocation applies RM 2,000 — RM 3,000 paid
   ahead. */
const world = (over: { allocSen?: number; totalSen?: number } = {}) => {
  const totalSen = over.totalSen ?? 500_000;
  const allocSen = over.allocSen ?? 200_000;
  const tables: Record<string, Row[]> = {
    payment_vouchers: [{
      id: 'pv-1', pv_number: 'HC-PV-2609-001', company_id: CO, status: 'DRAFT',
      voucher_date: '2026-09-02', payee_name: 'Foshan Chairs', supplier_id: 'sup-1',
      credit_account_code: '1000', currency: 'MYR', exchange_rate: 1,
      purpose: 'SUPPLIER_PAYMENT', total_sen: totalSen,
      submitted_at: '2026-09-02T01:00:00Z', submitted_by: 'Tester',
      approved_at: '2026-09-02T02:00:00Z', approved_by: 'Tester',
    }],
    payment_voucher_lines: [{
      id: 'pvl-1', pv_id: 'pv-1', line_no: 1, description: 'Settle + prepay',
      debit_account_code: '400-0000', amount_sen: totalSen,
    }],
    pv_allocations: allocSen > 0
      ? [{ id: 'alloc-1', pv_id: 'pv-1', pi_id: 'pi-1', amount_sen: allocSen, applied_sen: 0, from_advance: false }]
      : [],
    purchase_invoices: [
      { id: 'pi-1', invoice_number: 'HC-PI-2609-001', company_id: CO, status: 'POSTED', currency: 'MYR', exchange_rate: 1, grn_id: null, total_sen: 200_000, paid_sen: 0 },
      { id: 'pi-2', invoice_number: 'HC-PI-2609-002', company_id: CO, status: 'POSTED', currency: 'MYR', exchange_rate: 1, grn_id: null, total_sen: 150_000, paid_sen: 0 },
      { id: 'pi-b', invoice_number: '2990-PI-2609-009', company_id: 2, status: 'POSTED', currency: 'MYR', exchange_rate: 1, grn_id: null, total_sen: 99_000, paid_sen: 0 },
    ],
    acc_supplier_advances: [],
    journal_entries: [], journal_entry_lines: [], entity_audit_log: [], suppliers: [],
  };
  return tables;
};

const post = (app: Hono) => app.request('/payment-vouchers/pv-1/post', { method: 'POST' });
const apply = (app: Hono, allocations: Array<{ piId: string; amountSen: number }>) =>
  app.request('/payment-vouchers/pv-1/apply-advance', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allocations }),
  });

describe('paying ahead records the advance', () => {
  test('the excess over the allocations becomes the supplier advance, said in the response', async () => {
    const t = world();
    const res = await post(harness(t));
    expect(res.status).toBe(200);
    expect((await res.json() as Row).advanceSen).toBe(300_000);
    expect(t.acc_supplier_advances).toHaveLength(1);
    expect(t.acc_supplier_advances[0]).toMatchObject({
      supplier_id: 'sup-1', pv_id: 'pv-1', amount_sen: 300_000, applied_sen: 0,
    });
  });

  test('an exact payment records nothing', async () => {
    const t = world({ totalSen: 200_000, allocSen: 200_000 });
    const res = await post(harness(t));
    expect(res.status).toBe(200);
    expect((await res.json() as Row).advanceSen).toBeUndefined();
    expect(t.acc_supplier_advances).toHaveLength(0);
  });
});

describe('spending the advance', () => {
  const postedWorld = async () => {
    const t = world();
    await post(harness(t));
    return t;
  };

  test('applies to a real invoice with the payment clamp, burns applied_sen, posts NOTHING', async () => {
    const t = await postedWorld();
    const jeCountBefore = t.journal_entries.length;

    const res = await apply(harness(t), [{ piId: 'pi-2', amountSen: 150_000 }]);
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body.appliedSen).toBe(150_000);
    expect(body.remainingSen).toBe(150_000);

    expect(t.purchase_invoices.find((p) => p.id === 'pi-2')!.paid_sen).toBe(150_000);
    expect(t.acc_supplier_advances[0]!.applied_sen).toBe(150_000);
    /* The knock-off row is marked as bookkeeping, not money. */
    const knock = t.pv_allocations.find((a) => a.pi_id === 'pi-2')!;
    expect(knock).toMatchObject({ from_advance: true, amount_sen: 150_000, applied_sen: 150_000 });
    /* No journal: both legs were already in AP. */
    expect(t.journal_entries.length).toBe(jeCountBefore);
  });

  test('asking past what remains is refused by name, and nothing moves', async () => {
    const t = await postedWorld();
    const res = await apply(harness(t), [{ piId: 'pi-2', amountSen: 350_000 }]);
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('exceeds_advance');
    expect(t.purchase_invoices.find((p) => p.id === 'pi-2')!.paid_sen).toBe(0);
    expect(t.acc_supplier_advances[0]!.applied_sen).toBe(0);
  });

  test("another company's invoice is refused before anything settles", async () => {
    const t = await postedWorld();
    const res = await apply(harness(t), [{ piId: 'pi-b', amountSen: 50_000 }]);
    expect(res.status).toBe(404);
    expect((await res.json() as Row).error).toBe('allocation_not_in_company');
    expect(t.purchase_invoices.find((p) => p.id === 'pi-b')!.paid_sen).toBe(0);
  });

  test('the clamp records what LANDED, not what was asked', async () => {
    const t = await postedWorld();
    /* pi-1 already carries the voucher's own RM 2,000 — fully paid. Asking to
       knock another 100,000 off it applies 0; the advance keeps its money. */
    const res = await apply(harness(t), [{ piId: 'pi-1', amountSen: 100_000 }]);
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body.appliedSen).toBe(0);
    expect(t.acc_supplier_advances[0]!.applied_sen).toBe(0);
  });
});

describe('cancel discipline', () => {
  test('a spent advance pins its voucher — cancel refused by name', async () => {
    const t = world();
    await post(harness(t));
    await apply(harness(t), [{ piId: 'pi-2', amountSen: 100_000 }]);
    const res = await harness(t).request('/payment-vouchers/pv-1/cancel', { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json() as Row).error).toBe('advance_applied');
    expect(t.payment_vouchers[0]!.status).toBe('POSTED');
  });

  test('an unspent advance cancels with its voucher, row and all', async () => {
    const t = world();
    await post(harness(t));
    expect(t.acc_supplier_advances).toHaveLength(1);
    const res = await harness(t).request('/payment-vouchers/pv-1/cancel', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(t.acc_supplier_advances).toHaveLength(0);
  });
});

describe('the advances window', () => {
  test('lists only what still has money on it, with the total', async () => {
    const t = world();
    await post(harness(t));
    t.acc_supplier_advances.push({
      id: 99, company_id: CO, supplier_id: 'sup-2', pv_id: 'pv-9', pv_number: 'HC-PV-2609-009',
      amount_sen: 50_000, applied_sen: 50_000, created_at: '2026-09-01T00:00:00Z',
    });
    const res = await harness(t).request('/payment-vouchers/advances/list?supplierId=sup-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { advances: Row[]; totalRemainingSen: number };
    expect(body.advances).toHaveLength(1);
    expect(body.advances[0]).toMatchObject({ pv_number: 'HC-PV-2609-001', remaining_sen: 300_000 });
    expect(body.totalRemainingSen).toBe(300_000);
  });
});
