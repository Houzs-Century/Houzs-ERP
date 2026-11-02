// GET /payment-vouchers — the redesign's search across every stage and month,
// the chips' counts, and each voucher's journal (owner's Claude Design, batch
// 4). What is pinned:
//   • ?q= finds a voucher by its number, payee, notes, bill number, an amount
//     typed as money, its supplier's name, its journal number and the number
//     of a bill it pays — and never another company's;
//   • ?counts=1 counts each stage over the company (Prepared and Checked are
//     DRAFTs wearing marks; an advance is open while it exceeds what bills used);
//   • each row carries the journal its approval posted — the live one when an
//     earlier one was reversed.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { listPaymentVouchersHandler, moneyQuery } from '../src/scm/routes/payment-vouchers-list';

const CO = 1;
type Row = Record<string, unknown>;

/* A small in-memory PostgREST: the builder methods the list reads with. */
function fakeSb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = [];
      let head = false;
      let order: { col: string; asc: boolean } | null = null;
      let limit = Infinity;
      const b: any = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) { head = !!opts?.head; return b; },
        eq(col: string, v: unknown) { preds.push((r) => r[col] === v); return b; },
        is(col: string, v: unknown) { preds.push((r) => (r[col] ?? null) === v); return b; },
        not(col: string, op: string, v: unknown) { if (op === 'is') preds.push((r) => (r[col] ?? null) !== v); return b; },
        in(col: string, vs: unknown[]) { preds.push((r) => vs.includes(r[col])); return b; },
        ilike(col: string, pattern: string) {
          const needle = pattern.replace(/^%|%$/g, '').replace(/\\([\\%_])/g, '$1').toLowerCase();
          preds.push((r) => String(r[col] ?? '').toLowerCase().includes(needle));
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) { order = { col, asc: o?.ascending !== false }; return b; },
        limit(n: number) { limit = n; return b; },
        range(f: number, t: number) { limit = t - f + 1; return b; },
        then(resolve: (v: unknown) => void) {
          let rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
          if (order) { const { col, asc } = order; rows = [...rows].sort((x, y) => String(x[col] ?? '').localeCompare(String(y[col] ?? '')) * (asc ? 1 : -1)); }
          rows = rows.slice(0, limit);
          resolve(head ? { data: null, count: rows.length, error: null } : { data: rows, error: null });
        },
      };
      return b;
    },
  };
}

const PV = (over: Row): Row => ({
  company_id: CO, status: 'DRAFT', submitted_at: null, checked_at: null, supplier_id: null, bill_ref: null, notes: null, total_sen: 10_000,
  supplier: null, ...over,
});
const tables = (): Record<string, Row[]> => ({
  payment_vouchers: [
    PV({ id: 'd1', pv_number: 'HCDraft-2611-001', payee_name: 'TNB', voucher_date: '2026-11-01', notes: 'Electricity October' }),
    PV({ id: 'p1', pv_number: 'HCDraft-2611-002', payee_name: 'MK Properties', voucher_date: '2026-11-02', submitted_at: '2026-11-02T01:00:00Z', total_sen: 123_450 }),
    PV({ id: 'c1', pv_number: 'HCMPV-2611-001', payee_name: 'Kian Furniture', voucher_date: '2026-10-30', submitted_at: 'x', checked_at: 'y', supplier_id: 'sup-k' }),
    PV({ id: 'a1', pv_number: 'HCMPV-2610-009', payee_name: 'Foshan Chairs', voucher_date: '2026-10-05', status: 'POSTED', bill_ref: 'FS-7781' }),
    PV({ id: 'x1', pv_number: 'HCMPV-2609-003', payee_name: 'Old Co', voucher_date: '2026-09-03', status: 'CANCELLED' }),
    /* Another company's: never found, never counted. */
    PV({ id: 'z9', pv_number: '2990MPV-2611-001', payee_name: 'TNB', voucher_date: '2026-11-01', company_id: 2 }),
  ],
  suppliers: [{ id: 'sup-k', company_id: CO, name: 'Kian Furniture Sdn Bhd', code: '400-K001' }],
  journal_entries: [
    { company_id: CO, source_type: 'PV', source_doc_no: 'HCMPV-2610-009', je_no: 'HC-JE-2610-0100', reversed: true },
    { company_id: CO, source_type: 'PV', source_doc_no: 'HCMPV-2610-009', je_no: 'HC-JE-2610-0144', reversed: false },
  ],
  purchase_invoices: [{ id: 'pi-1', company_id: CO, invoice_number: 'HC-PI-2610-020', supplier_invoice_ref: 'INV-55' }],
  ap_invoices: [],
  pv_allocations: [{ company_id: CO, pv_id: 'c1', pi_id: 'pi-1', ap_invoice_id: null }],
  acc_supplier_advances: [
    { company_id: CO, pv_id: 'a1', amount_sen: 50_000, applied_sen: 20_000 },
    { company_id: CO, pv_id: 'x1', amount_sen: 10_000, applied_sen: 10_000 },
  ],
});

const app = (t = tables()) => {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, fakeSb(t) as never);
    c.set('companyId' as never, CO as never);
    await next();
  });
  a.get('/payment-vouchers', listPaymentVouchersHandler as never);
  return a;
};
const get = async (qs: string) => {
  const res = await app().request(`/payment-vouchers${qs}`);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ paymentVouchers: Row[]; counts?: Record<string, number>; q?: string }>;
};
const numbers = (r: { paymentVouchers: Row[] }) => r.paymentVouchers.map((v) => v.pv_number);

describe('searching every stage and month (?q=)', () => {
  test('by payee and notes, newest first, and never another company\'s', async () => {
    expect(numbers(await get('?q=tnb'))).toEqual(['HCDraft-2611-001']);
    expect(numbers(await get('?q=electricity'))).toEqual(['HCDraft-2611-001']);
  });

  test('by an amount typed as money, by the bill number, by the supplier\'s name', async () => {
    expect(numbers(await get('?q=1%2C234.50'))).toEqual(['HCDraft-2611-002']);
    expect(numbers(await get('?q=FS-7781'))).toEqual(['HCMPV-2610-009']);
    expect(numbers(await get('?q=kian%20furniture%20sdn'))).toEqual(['HCMPV-2611-001']);
  });

  test('by the journal its approval posted, and by the number of a bill it pays', async () => {
    expect(numbers(await get('?q=JE-2610-0144'))).toEqual(['HCMPV-2610-009']);
    expect(numbers(await get('?q=HC-PI-2610-020'))).toEqual(['HCMPV-2611-001']);
    expect(numbers(await get('?q=INV-55'))).toEqual(['HCMPV-2611-001']);
  });

  test('a search that finds nothing is an empty list, said as the search', async () => {
    const r = await get('?q=nobody-here');
    expect(r.paymentVouchers).toEqual([]);
    expect(r.q).toBe('nobody-here');
  });
});

describe('the chips\' counts (?counts=1)', () => {
  test('count each stage over the company; an advance is open while it exceeds what bills used', async () => {
    const r = await get('?counts=1');
    expect(r.counts).toEqual({ all: 5, DRAFT: 1, PREPARED: 1, CHECKED: 1, POSTED: 1, ADVANCE: 1, CANCELLED: 1 });
  });

  test('the plain list carries no counts', async () => {
    expect((await get('')).counts).toBeUndefined();
  });
});

describe('each voucher\'s journal', () => {
  test('the live entry wins over one that was reversed; a voucher not approved has none', async () => {
    const r = await get('');
    const byNo = new Map(r.paymentVouchers.map((v) => [v.pv_number, v]));
    expect(byNo.get('HCMPV-2610-009')!.je_no).toBe('HC-JE-2610-0144');
    expect(byNo.get('HCDraft-2611-001')!.je_no).toBeNull();
    expect(byNo.get('HCMPV-2610-009')!.advance_remaining_sen).toBe(30_000);
  });
});

describe('moneyQuery', () => {
  test('reads money the way people type it, and nothing else', () => {
    expect(moneyQuery('1,234.50')).toBe(123_450);
    expect(moneyQuery('RM 300')).toBe(30_000);
    expect(moneyQuery('HC-PI-2610-020')).toBeNull();
    expect(moneyQuery('12.345')).toBeNull();
  });
});
