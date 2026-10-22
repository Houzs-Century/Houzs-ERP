/* The formal AR / AP Aging (owner 2026-10-02), on the real handlers over fake
   PostgREST. Pinned:
     AR  an order's money pays the order's own invoices; a deposit on an order
         not invoiced yet is 未冲, not spent on another order's bill; a deposit
         invoice and the credit note that closes it net away; money moved off a
         cancelled order lands on the order it went to; a refund nets with the
         payment it gives back; an Other Debtor receipt knocks off the bill it is
         allocated to and the rest is 未冲; the rows add up to 300 + 305;
     AP  an AP Payment's ticks knock off the invoices they name; an advance
         applied later counts from that day; a supplier credit note's knock-off
         counts from its day; a payment applied to nothing is 未冲; a foreign
         invoice's tick turns into ringgit at its rate; the rows add up to
         400 + 405; one control alone; AutoCount bills are counted apart;
     both: lines after the as-at date are not there; by due date; by days;
     AR: an order owing here that AutoCount took a deposit on is counted in the
         footer (paidBeforeErp), never knocked off — the aging is the books. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { apAgingHandler, arAgingHandler } from '../src/scm/routes/accounting-aging';

const CO = 2;
let seq = 0;
const gl = (code: string, type: string, doc: string, date: string, dr: number, cr: number, party: string | null = null, over: Row = {}): Row => ({
  line_id: `l${++seq}`, je_no: `JE-${seq}`, entry_date: date, source_type: type, source_doc_no: doc, account_code: code,
  party_type: party ? 'CUSTOMER' : null, party_code: party, party_name: party, debit_sen: dr, credit_sen: cr,
  posted: true, reversed: false, reversed_by_je: null, company_id: CO, ...over,
});

function app(tables: Record<string, Row[]>) {
  const sb = fakeSb({ acc_account_roles: [], ...tables });
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    await next();
  });
  a.get('/ar-aging', arAgingHandler as never);
  a.get('/ap-aging', apAgingHandler as never);
  return a;
}

/* ── AR ─────────────────────────────────────────────────────────────────── */
const AR = (): Record<string, Row[]> => ({
  v_gl_entries: [
    /* SO-A: deposit 500, invoice 1,200 in August, balance 300 — owes 400. */
    gl('300-0000', 'SOPAY', 'pay-a1', '2026-07-05', 0, 500, 'C-1'),
    gl('300-0000', 'SI', 'SI-A1', '2026-08-10', 1_200, 0, 'C-1'),
    gl('300-0000', 'SOPAY', 'pay-a2', '2026-08-20', 0, 300, 'C-1'),
    /* SO-B: a deposit on an order not invoiced yet, plus 200 moved in from SO-D. */
    gl('300-0000', 'SOPAY', 'pay-b1', '2026-09-15', 0, 1_000, 'C-1'),
    gl('300-0000', 'SOPAY', 'pay-d1', '2026-07-01', 0, 200, 'C-1'),
    gl('300-0000', 'SOCONV', 'pay-b2', '2026-07-15', 200, 0, 'C-1'),
    gl('300-0000', 'SOCONV', 'pay-b2', '2026-07-15', 0, 200, 'C-1'),
    /* SO-C (2990's deposit invoices): DI + payment, the final invoice, the CN closing the DI. */
    gl('300-0000', 'DI', 'DI-C1', '2026-06-01', 300, 0, 'cust-2'),
    gl('300-0000', 'SOPAY', 'pay-c1', '2026-06-01', 0, 300, 'cust-2'),
    gl('300-0000', 'SI', 'SI-C1', '2026-06-20', 900, 0, 'cust-2'),
    gl('300-0000', 'CN', 'CN-C1', '2026-06-20', 0, 300, 'cust-2'),
    /* SO-E: paid, then refunded. */
    gl('300-0000', 'SOPAY', 'pay-e1', '2026-08-01', 0, 400, 'cust-2'),
    gl('300-0000', 'PV', 'HRF-1', '2026-08-05', 400, 0, 'cust-2'),
    /* After the as-at date. */
    gl('300-0000', 'SI', 'SI-F', '2026-10-05', 777, 0, 'C-1'),
    /* A reversed pair counts nowhere. */
    gl('300-0000', 'SI', 'SI-X', '2026-09-01', 999, 0, 'C-1', { reversed: true }),
    /* Other debtors: a bill, a receipt part-allocated to it — no party on the lines. */
    gl('305-0000', 'ODB', 'ODB-1', '2026-09-01', 5_000, 0, null),
    gl('305-0000', 'ODR', 'ODR-1', '2026-09-10', 0, 3_000, null),
  ],
  mfg_sales_order_payments: [
    { id: 'pay-a1', company_id: CO, so_doc_no: 'SO-A' }, { id: 'pay-a2', company_id: CO, so_doc_no: 'SO-A' },
    { id: 'pay-b1', company_id: CO, so_doc_no: 'SO-B' }, { id: 'pay-d1', company_id: CO, so_doc_no: 'SO-D' },
    { id: 'pay-b2', company_id: CO, so_doc_no: 'SO-B', converted_from_so_doc_no: 'SO-D' },
    { id: 'pay-c1', company_id: CO, so_doc_no: 'SO-C' }, { id: 'pay-e1', company_id: CO, so_doc_no: 'SO-E' },
    /* A deposit AutoCount took before the move — no line in these books. */
    { id: 'pay-a0', company_id: CO, so_doc_no: 'SO-A', method: 'imported', amount_sen: 600 },
  ],
  sales_invoice_payments: [],
  sales_invoices: [
    { id: 'si-a1', company_id: CO, invoice_number: 'SI-A1', so_doc_no: 'SO-A', due_date: null, debtor_code: 'C-1', debtor_name: 'ALI', status: 'SENT', total_sen: 1_200, paid_sen: 0, migrated_no_stock: false },
    { id: 'si-c1', company_id: CO, invoice_number: 'SI-C1', so_doc_no: 'SO-C', due_date: '2026-07-20', debtor_code: null, debtor_name: 'BEE', status: 'SENT', total_sen: 900, paid_sen: 0, migrated_no_stock: false },
    { id: 'si-old', company_id: CO, invoice_number: 'SI-OLD', so_doc_no: 'SO-OLD', due_date: null, debtor_code: 'C-9', debtor_name: 'OLD', status: 'SENT', total_sen: 5_000, paid_sen: 1_000, migrated_no_stock: true },
  ],
  acc_deposit_invoices: [{ di_number: 'DI-C1', company_id: CO, so_doc_no: 'SO-C' }],
  acc_credit_notes: [{ note_number: 'CN-C1', company_id: CO, kind: 'CN', so_doc_no: 'SO-C', sales_invoice_id: 'si-c1' }],
  payment_vouchers: [{ pv_number: 'HRF-1', company_id: CO, refund_source_type: 'SO', refund_source_doc_no: 'SO-E' }],
  acc_debtor_bills: [{ id: 'b-1', company_id: CO, bill_number: 'ODB-1', debtor_id: 'd-1' }],
  acc_debtor_receipts: [{ id: 'r-1', company_id: CO, receipt_number: 'ODR-1', debtor_id: 'd-1' }],
  acc_debtor_receipt_allocations: [{ id: 'ra-1', company_id: CO, receipt_id: 'r-1', bill_id: 'b-1', amount_sen: 2_000 }],
  acc_debtors: [{ id: 'd-1', company_id: CO, name: 'LANDLORD CO' }],
  mfg_sales_orders: [
    { doc_no: 'SO-A', company_id: CO, debtor_code: 'C-1', debtor_name: 'ALI', customer_id: 'cust-1' },
    { doc_no: 'SO-B', company_id: CO, debtor_code: 'C-1', debtor_name: 'ALI', customer_id: 'cust-1' },
    { doc_no: 'SO-D', company_id: CO, debtor_code: 'C-1', debtor_name: 'ALI', customer_id: 'cust-1' },
    { doc_no: 'SO-C', company_id: CO, debtor_code: null, debtor_name: 'BEE', customer_id: 'cust-2' },
    { doc_no: 'SO-E', company_id: CO, debtor_code: null, debtor_name: 'BEE', customer_id: 'cust-2' },
  ],
});

type Body = { rows: Row[]; totals: Row; controls: Row[]; differenceSen: number; outside: Row; asOf: string };
const rowOf = (b: Body, name: string) => b.rows.find((r) => r.name === name)!;

describe('AR Aging', () => {
  test('orders pay their own invoices; deposits on orders not invoiced are 未冲; it adds up to 300 + 305', async () => {
    const res = await app(AR()).request('/ar-aging?asOf=2026-09-30');
    expect(res.status).toBe(200);
    const b = await res.json() as Body;
    expect(rowOf(b, 'ALI')).toMatchObject({ key: 'C-1', code: 'C-1', balanceSen: -800, unappliedSen: -1_200, cells: [0, 400, 0, 0, 0] });
    expect((rowOf(b, 'ALI').items as Row[]).map((i) => [i.docNo, i.openSen])).toEqual([['SI-A1', 400]]);
    expect((rowOf(b, 'ALI').unapplied as Row[]).reduce((n, u) => n + Number(u.amountSen), 0)).toBe(-1_200);
    expect(rowOf(b, 'BEE')).toMatchObject({ key: 'cust-2', balanceSen: 600, unappliedSen: 0, cells: [0, 0, 0, 600, 0] });
    expect(rowOf(b, 'LANDLORD CO')).toMatchObject({ key: 'DEBTOR:d-1', balanceSen: 2_000, unappliedSen: -1_000, cells: [3_000, 0, 0, 0, 0] });
    expect(b.totals).toMatchObject({ balanceSen: 1_800 });
    expect(b.controls).toEqual([{ code: '300-0000', balanceSen: -200 }, { code: '305-0000', balanceSen: 2_000 }]);
    expect(b.differenceSen).toBe(0);
    expect(b.outside).toEqual({ count: 1, sen: 4_000 });
    /* SO-A owes 400 here, and AutoCount took 600 on it before the ERP: said, not knocked off. */
    expect((b as unknown as { paidBeforeErp: Row }).paidBeforeErp).toEqual({ orders: 1, sen: 400 });
  });

  test('by due date, by days, one control, and an earlier as-at day', async () => {
    const a = app(AR());
    const due = await (await a.request('/ar-aging?asOf=2026-09-30&basis=due')).json() as Body;
    expect(rowOf(due, 'BEE').cells).toEqual([0, 0, 600, 0, 0]);
    const days = await (await a.request('/ar-aging?asOf=2026-09-30&buckets=day')).json() as Body;
    expect(rowOf(days, 'ALI').cells).toEqual([0, 400, 0, 0, 0]);
    const other = await (await a.request('/ar-aging?asOf=2026-09-30&control=other')).json() as Body;
    expect(other.rows.map((r) => r.name)).toEqual(['LANDLORD CO']);
    expect(other.controls).toEqual([{ code: '305-0000', balanceSen: 2_000 }]);
    /* 31 August: SO-B's deposit and the bill were not there yet. */
    const aug = await (await a.request('/ar-aging?asOf=2026-08-31&control=trade')).json() as Body;
    expect(rowOf(aug, 'ALI')).toMatchObject({ balanceSen: 200, unappliedSen: -200, cells: [400, 0, 0, 0, 0] });
    expect(aug.differenceSen).toBe(0);
    expect((await a.request('/ar-aging?asOf=31-08-2026')).status).toBe(400);
  });
});

/* ── AP ─────────────────────────────────────────────────────────────────── */
const SUP: Row = { party_type: 'SUPPLIER' };
const AP = (): Record<string, Row[]> => ({
  v_gl_entries: [
    gl('400-0000', 'PI', 'PI-1', '2026-07-10', 0, 10_000, '400-B001', SUP),
    gl('400-0000', 'PV', 'PV-1', '2026-08-01', 6_000, 0, '400-B001', SUP),
    gl('400-0000', 'PI', 'PI-2', '2026-09-05', 0, 3_000, '400-B001', SUP),
    gl('400-0000', 'SCN', 'SCN-1', '2026-09-25', 500, 0, '400-B001', SUP),
    gl('405-0000', 'API', 'API-1', '2026-08-15', 0, 2_000, '405-H001', SUP),
    gl('405-0000', 'PV', 'PV-2', '2026-08-20', 2_000, 0, '405-H001', SUP),
    gl('400-0000', 'PI', 'PI-F', '2026-06-15', 0, 6_200, '400-F001', SUP),
    gl('400-0000', 'PV', 'PV-3', '2026-07-01', 3_100, 0, '400-F001', SUP),
    gl('400-0000', 'PI', 'PI-LATE', '2026-10-02', 0, 999, '400-B001', SUP),
  ],
  purchase_invoices: [
    { id: 'pi-1', company_id: CO, invoice_number: 'PI-1', due_date: '2026-08-09', exchange_rate: 1, status: 'PARTIALLY_PAID', total_sen: 10_000, paid_sen: 4_000, migrated_no_stock: false },
    { id: 'pi-2', company_id: CO, invoice_number: 'PI-2', due_date: null, exchange_rate: 1, status: 'PARTIALLY_PAID', total_sen: 3_000, paid_sen: 2_000, migrated_no_stock: false },
    { id: 'pi-f', company_id: CO, invoice_number: 'PI-F', due_date: null, exchange_rate: 0.62, status: 'PARTIALLY_PAID', total_sen: 10_000, paid_sen: 5_000, migrated_no_stock: false },
    { id: 'pi-old', company_id: CO, invoice_number: 'PI-OLD', due_date: null, exchange_rate: 1, status: 'POSTED', total_sen: 7_000, paid_sen: 0, migrated_no_stock: true },
  ],
  ap_invoices: [{ id: 'api-1', company_id: CO, invoice_number: 'API-1', due_date: null }],
  payment_vouchers: [
    { id: 'pv-1', company_id: CO, pv_number: 'PV-1', voucher_date: '2026-08-01' },
    { id: 'pv-2', company_id: CO, pv_number: 'PV-2', voucher_date: '2026-08-20' },
    { id: 'pv-3', company_id: CO, pv_number: 'PV-3', voucher_date: '2026-07-01' },
  ],
  pv_allocations: [
    { id: 'a-1', company_id: CO, pv_id: 'pv-1', pi_id: 'pi-1', ap_invoice_id: null, applied_sen: 4_000, from_advance: false, created_at: '2026-08-01T02:00:00Z' },
    /* The rest of PV-1 was an advance, applied to PI-2 on 20 September. */
    { id: 'a-2', company_id: CO, pv_id: 'pv-1', pi_id: 'pi-2', ap_invoice_id: null, applied_sen: 1_500, from_advance: true, created_at: '2026-09-20T02:00:00Z' },
    /* 5,000.00 RMB at 0.62 = 3,100.00 ringgit. */
    { id: 'a-3', company_id: CO, pv_id: 'pv-3', pi_id: 'pi-f', ap_invoice_id: null, applied_sen: 5_000, from_advance: false, created_at: '2026-07-01T02:00:00Z' },
  ],
  acc_credit_notes: [{ id: 'cn-1', company_id: CO, note_number: 'SCN-1', note_date: '2026-09-25' }],
  acc_credit_note_allocations: [{ id: 'k-1', company_id: CO, note_id: 'cn-1', purchase_invoice_id: 'pi-2', ap_invoice_id: null, applied_sen: 500, created_at: '2026-09-25T03:00:00Z' }],
  suppliers: [
    { id: 's-1', company_id: CO, code: '400-B001', name: 'BEST BED' },
    { id: 's-2', company_id: CO, code: '405-H001', name: 'HOUZS VENTURE HOLDING' },
    { id: 's-3', company_id: CO, code: '400-F001', name: 'FOSHAN CO' },
  ],
});

describe('AP Aging', () => {
  test('ticks knock off the invoices they name; a payment applied to nothing is 未冲; it adds up to 400 + 405', async () => {
    const b = await (await app(AP()).request('/ap-aging?asOf=2026-09-30')).json() as Body;
    expect(rowOf(b, 'BEST BED')).toMatchObject({ key: '400-B001', balanceSen: 6_500, unappliedSen: -500, cells: [1_000, 0, 6_000, 0, 0] });
    expect((rowOf(b, 'BEST BED').unapplied as Row[]).map((u) => [u.docNo, u.amountSen])).toEqual([['PV-1', -500]]);
    expect(rowOf(b, 'HOUZS VENTURE HOLDING')).toMatchObject({ balanceSen: 0, unappliedSen: -2_000, cells: [0, 2_000, 0, 0, 0] });
    expect(rowOf(b, 'FOSHAN CO')).toMatchObject({ balanceSen: 3_100, cells: [0, 0, 0, 3_100, 0] });
    expect(b.controls).toEqual([{ code: '400-0000', balanceSen: 9_600 }, { code: '405-0000', balanceSen: 0 }]);
    expect(b.differenceSen).toBe(0);
    expect(b.outside).toEqual({ count: 1, sen: 7_000 });
  });

  test('as at 10 September: the advance was not applied yet and the credit note not there', async () => {
    const b = await (await app(AP()).request('/ap-aging?asOf=2026-09-10&control=trade')).json() as Body;
    expect(rowOf(b, 'BEST BED')).toMatchObject({ balanceSen: 7_000, unappliedSen: -2_000, cells: [3_000, 0, 6_000, 0, 0] });
    expect(b.rows.some((r) => r.name === 'HOUZS VENTURE HOLDING')).toBe(false);
    expect(b.differenceSen).toBe(0);
  });
});
