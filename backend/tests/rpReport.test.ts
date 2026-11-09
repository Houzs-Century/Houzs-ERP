/* The Receipts & Payments report (owner 2026-09-06/07). Pinned:
     • money accounts are the columns, opening = posted movements before the
       period, closing = opening + receipts − payments, per column;
     • rows are the OTHER side, in the owner's own accounts — a customer
       collection reads as the AR control, an expense voucher as its account;
     • a SUPPLIER payment reads through what it settled (rule A): a PI's own
       purchase groups in the PI's proportion, an AP invoice's own lines, and
       what it paid beyond that as "Supplier advances";
     • a transfer between two money accounts reads as Transfer to/from;
     • party=1 names the control rows by debtor/creditor and does not split;
     • reversed journals are invisible — the original AND the contra that undid
       it, whichever month the contra is dated in (docs/bugs/0923); an account
       filter narrows the columns.
   Real handler, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { receiptsPaymentsReport } from '../src/scm/routes/accounting-rp';

const CO = 2;
let lineId = 0;
const gl = (jeNo: string, date: string, source: string, doc: string | null, code: string, name: string, dr: number, cr: number, extra: Row = {}): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc,
  account_code: code, account_name: name, debit_sen: dr, credit_sen: cr, party_type: null, party_name: null, notes: null,
  posted: true, reversed: false, ...extra,
});

const world = () => fakeSb({
  accounts: [
    { company_id: CO, account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', acc_money: true, is_active: true, account_type: 'ASSET', section: 'CURRENT ASSETS' },
    { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', acc_money: true, is_active: true, account_type: 'ASSET', section: 'CURRENT ASSETS' },
    { company_id: CO, account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', acc_money: false, is_active: true, account_type: 'ASSET', section: 'CURRENT ASSETS' },
    { company_id: CO, account_code: '326-0000', account_name: 'CARD MACHINE CLEARING (EDC)', acc_money: false, is_active: true, account_type: 'ASSET', section: 'CURRENT ASSETS' },
    { company_id: CO, account_code: '326-0010', account_name: 'CARD MACHINE CLEARING — PBB', acc_money: false, is_active: true, account_type: 'ASSET', section: 'CURRENT ASSETS' },
    { company_id: CO, account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', acc_money: false, is_active: true, account_type: 'LIABILITY', section: 'CURRENT LIABILITIES' },
    { company_id: CO, account_code: '405-0000', account_name: 'OTHER CREDITORS', acc_money: false, is_active: true, account_type: 'LIABILITY', section: 'CURRENT LIABILITIES' },
    { company_id: CO, account_code: '900-A001', account_name: 'RENTAL', acc_money: false, is_active: true, account_type: 'EXPENSE', section: 'EXPENSES' },
    { company_id: CO, account_code: '910-0000', account_name: 'UTILITIES', acc_money: false, is_active: true, account_type: 'EXPENSE', section: 'EXPENSES' },
    { company_id: CO, account_code: '601-0003', account_name: 'PURCHASE OF SOFA', acc_money: false, is_active: true, account_type: 'EXPENSE', section: 'COST OF GOODS SOLD' },
    { company_id: CO, account_code: '601-0001', account_name: 'PURCHASE OF BEDDING', acc_money: false, is_active: true, account_type: 'EXPENSE', section: 'COST OF GOODS SOLD' },
  ],
  acc_account_roles: [],
  v_gl_entries: [
    /* Before the period: an expense paid from the bank → opening −100.00 */
    gl('JE-0', '2026-06-30', 'PV', 'PV-0', '900-A001', 'RENTAL', 10000, 0),
    gl('JE-0', '2026-06-30', 'PV', 'PV-0', '310-0010', 'CASH AT BANK - MAYBANK', 0, 10000),
    /* A customer collection into the bank. */
    gl('JE-1', '2026-07-05', 'SOPAY', 'pay-1', '310-0010', 'CASH AT BANK - MAYBANK', 50000, 0),
    gl('JE-1', '2026-07-05', 'SOPAY', 'pay-1', '300-0000', 'ACCOUNT RECEIVEABLE', 0, 50000, { party_type: 'CUSTOMER', party_name: 'Ah Meng' }),
    /* An expense voucher from the drawer. */
    gl('JE-2', '2026-07-10', 'PV', 'PV-2', '910-0000', 'UTILITIES', 6000, 0),
    gl('JE-2', '2026-07-10', 'PV', 'PV-2', '320-0000', 'CASH IN HAND', 0, 6000),
    /* A supplier payment: 1,000 to the trade creditor, settling PI-1 (700) and 300 ahead. */
    gl('JE-3', '2026-07-15', 'PV', 'PV-3', '400-0000', 'ACCOUNT PAYABLE', 100000, 0, { party_type: 'SUPPLIER', party_name: 'FOSHAN CHAIRS' }),
    gl('JE-3', '2026-07-15', 'PV', 'PV-3', '310-0010', 'CASH AT BANK - MAYBANK', 0, 100000),
    /* PI-1's own journal (June): sofa 400 + bedding 300 / AP 700. */
    gl('JE-PI', '2026-06-20', 'PI', 'PI-1', '601-0003', 'PURCHASE OF SOFA', 40000, 0),
    gl('JE-PI', '2026-06-20', 'PI', 'PI-1', '601-0001', 'PURCHASE OF BEDDING', 30000, 0),
    gl('JE-PI', '2026-06-20', 'PI', 'PI-1', '400-0000', 'ACCOUNT PAYABLE', 0, 70000),
    /* A transfer bank → drawer. */
    gl('JE-4', '2026-07-20', 'MANUAL', null, '320-0000', 'CASH IN HAND', 20000, 0),
    gl('JE-4', '2026-07-20', 'MANUAL', null, '310-0010', 'CASH AT BANK - MAYBANK', 0, 20000),
    /* An AP-invoice payment: 50 to the other creditor for a rent bill. */
    gl('JE-5', '2026-07-25', 'PV', 'PV-5', '405-0000', 'OTHER CREDITORS', 5000, 0, { party_type: 'SUPPLIER', party_name: 'HOUZS VENTURE' }),
    gl('JE-5', '2026-07-25', 'PV', 'PV-5', '310-0010', 'CASH AT BANK - MAYBANK', 0, 5000),
    /* A reversed voucher — invisible — and the contra that undid it, dated in
       the same period: not a receipt of the month (docs/bugs/0923). */
    gl('JE-9', '2026-07-26', 'PV', 'PV-9', '910-0000', 'UTILITIES', 99900, 0, { reversed: true, reversed_by_je: 'je-9r' }),
    gl('JE-9', '2026-07-26', 'PV', 'PV-9', '310-0010', 'CASH AT BANK - MAYBANK', 0, 99900, { reversed: true, reversed_by_je: 'je-9r' }),
    gl('JE-9R', '2026-07-28', 'PV_REVERSAL', 'PV-9', '310-0010', 'CASH AT BANK - MAYBANK', 99900, 0, { reversed_by_je: 'je-9' }),
    gl('JE-9R', '2026-07-28', 'PV_REVERSAL', 'PV-9', '910-0000', 'UTILITIES', 0, 99900, { reversed_by_je: 'je-9' }),
    /* Card money (owner 2026-09-28): a June swipe on the generic EDC clearing, a July
       swipe on the PBB clearing, the acquirer's fee — none of it touches a money
       account, so the report's columns cannot see it; the memo lines can. */
    gl('JE-C0', '2026-06-25', 'SOPAY', 'pay-c0', '326-0000', 'CARD MACHINE CLEARING (EDC)', 5000, 0),
    gl('JE-C0', '2026-06-25', 'SOPAY', 'pay-c0', '300-0000', 'ACCOUNT RECEIVEABLE', 0, 5000, { party_type: 'CUSTOMER', party_name: 'Ah Meng' }),
    gl('JE-C1', '2026-07-15', 'SOPAY', 'pay-c1', '326-0010', 'CARD MACHINE CLEARING — PBB', 30000, 0),
    gl('JE-C1', '2026-07-15', 'SOPAY', 'pay-c1', '300-0000', 'ACCOUNT RECEIVEABLE', 0, 30000, { party_type: 'CUSTOMER', party_name: 'Ah Meng' }),
    gl('JE-C2', '2026-07-16', 'SETTLE', 'SETTLE-1', '900-T009', 'MERCHANT CHARGES', 300, 0),
    gl('JE-C2', '2026-07-16', 'SETTLE', 'SETTLE-1', '326-0010', 'CARD MACHINE CLEARING — PBB', 0, 300),
  ],
  payment_vouchers: [
    { id: 'pv-3', company_id: CO, pv_number: 'PV-3', status: 'POSTED' },
    { id: 'pv-5', company_id: CO, pv_number: 'PV-5', status: 'POSTED' },
  ],
  pv_allocations: [
    { id: 'al-3', company_id: CO, pv_id: 'pv-3', pi_id: 'pi-1', ap_invoice_id: null, amount_sen: 70000, applied_sen: 70000, from_advance: false },
    { id: 'al-5', company_id: CO, pv_id: 'pv-5', pi_id: null, ap_invoice_id: 'api-1', amount_sen: 5000, applied_sen: 5000, from_advance: false },
  ],
  purchase_invoices: [{ id: 'pi-1', company_id: CO, invoice_number: 'PI-1' }],
  ap_invoices: [{ id: 'api-1', company_id: CO, invoice_number: 'API-1' }],
  ap_invoice_lines: [{ id: 'l1', company_id: CO, invoice_id: 'api-1', debit_account_code: '900-A001', amount_sen: 5000 }],
  acc_report_layouts: [],
  acc_acquirers: [{ company_id: CO, code: 'PBB', display_name: 'PBB', transit_account_code: '326-0010', is_active: true }],
  /* pay-1 is the first 500.00 of a 1,000.00 order (a deposit); pay-c1 pays a 300.00 order in full (its balance). */
  mfg_sales_orders: [
    { company_id: CO, doc_no: 'SO-1', local_total_sen: 100000 },
    { company_id: CO, doc_no: 'SO-2', local_total_sen: 30000 },
  ],
  mfg_sales_order_payments: [
    { company_id: CO, id: 'pay-1', so_doc_no: 'SO-1', amount_sen: 50000, paid_at: '2026-07-05', created_at: '2026-07-05T03:00:00Z' },
    { company_id: CO, id: 'pay-c1', so_doc_no: 'SO-2', amount_sen: 30000, paid_at: '2026-07-15', created_at: '2026-07-15T03:00:00Z' },
  ],
});

function harness(sb: ReturnType<typeof fakeSb>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/accounting/reports/receipts-payments', receiptsPaymentsReport as never);
  return app;
}
type Report = {
  columns: Array<{ code: string; name: string }>; opening: Record<string, number>;
  receipts: Array<{ key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number }>;
  payments: Array<{ key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number }>;
  totals: { receipts: Record<string, number>; payments: Record<string, number>; closing: Record<string, number>; openingTotalSen: number; receiptsTotalSen: number; paymentsTotalSen: number; closingTotalSen: number };
  entries: Array<{ jeNo: string; side: 'R' | 'P'; rowKey: string; column: string; sen: number }>;
  card: { takingsSen: number; transitSen: number; codes: string[] };
};
const fetchReport = async (app: Hono, qs: string): Promise<Report> => {
  const res = await app.request(`/accounting/reports/receipts-payments?${qs}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Report;
};
const cell = (rows: Report['receipts'], key: string, col: string) => rows.find((r) => r.key === key)?.cells[col] ?? 0;

describe('Receipts & Payments — columns per money account, rows in the owner\'s accounts', () => {
  test('opening, the period, closing — and a supplier payment read through what it settled (rule A)', async () => {
    const r = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31');
    expect(r.columns.map((c) => c.code)).toEqual(['310-0010', '320-0000', 'CARD']);
    expect(r.opening).toEqual({ '310-0010': -10000, '320-0000': 0, CARD: 5000 });

    /* Receipts: the collection on AR into the bank; the transfer into the drawer. */
    expect(cell(r.receipts, '300-0000:DEP:CASH', '310-0010')).toBe(50000);
    expect(cell(r.receipts, 'XFER:310-0010', '320-0000')).toBe(20000);
    /* Payments: utilities from the drawer; the supplier payment split by PI-1's own
       groups (700 → sofa 400 / bedding 300) plus 300 paid ahead; the AP bill's rent;
       the transfer out of the bank. */
    expect(cell(r.payments, '910-0000', '320-0000')).toBe(6000);
    expect(cell(r.payments, '601-0003', '310-0010')).toBe(40000);
    expect(cell(r.payments, '601-0001', '310-0010')).toBe(30000);
    /* What it paid ahead of a bill reads as the creditor control (owner 2026-11-05). */
    expect(cell(r.payments, '400-0000', '310-0010')).toBe(30000);
    expect(r.payments.find((x) => x.key === 'ADV')).toBeUndefined();
    expect(cell(r.payments, '900-A001', '310-0010')).toBe(5000);
    expect(cell(r.payments, 'XFER:320-0000', '310-0010')).toBe(20000);
    /* The reversed voucher is invisible, and so is the contra that undid it. */
    expect(r.entries.some((e) => e.jeNo === 'JE-9')).toBe(false);
    expect(r.entries.some((e) => e.jeNo === 'JE-9R')).toBe(false);
    expect(r.receipts.find((x) => x.key === '910-0000')).toBeUndefined();

    expect(r.totals.receipts).toEqual({ '310-0010': 50000, '320-0000': 20000, CARD: 30000 });
    expect(r.totals.payments).toEqual({ '310-0010': 125000, '320-0000': 6000, CARD: 300 });
    expect(r.totals.closing).toEqual({ '310-0010': -85000, '320-0000': 14000, CARD: 34700 });
    expect(r.totals.closingTotalSen).toBe(-36300);
    /* Rows carry their Total; entries carry the drill-down. */
    expect(r.payments.find((x) => x.key === '601-0003')?.totalSen).toBe(40000);
    expect(r.entries.filter((e) => e.jeNo === 'JE-3').map((e) => [e.rowKey, e.sen]).sort()).toEqual([['400-0000', 30000], ['601-0001', 30000], ['601-0003', 40000]]);
  });

  test('the card money: a swipe is Cash In on its day into the Card column, its fee a payment out of it (owner 2026-11-05)', async () => {
    const july = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31');
    /* July's swipe, no report claims it: Card - not matched yet, on the debtor's row. */
    expect(july.receipts.find((x) => x.key === '326-0010')).toBeUndefined();
    expect(cell(july.receipts, '300-0000:BAL:CARD-UNMATCHED', 'CARD')).toBe(30000);
    expect(cell(july.payments, '900-T009', 'CARD')).toBe(300);
    /* The memo still reads: July's swipe (the fee is the settlement module's own, not a taking)
       and the balance at month end: June's 50.00 + July's 300.00 − the 3.00 fee = the Card c/f. */
    expect(july.totals.closing.CARD).toBe(34700);
    expect(july.card).toEqual({ takingsSen: 30000, transitSen: 34700, codes: ['326-0000', '326-0010'] });
    const june = await fetchReport(harness(world()), 'from=2026-06-01&to=2026-06-30');
    expect(june.card).toEqual({ takingsSen: 5000, transitSen: 5000, codes: ['326-0000', '326-0010'] });
  });

  test('party=1 keeps one row for a party whose name came in two casings (owner 2026-11-09: Finance writes names upper case from now on)', async () => {
    const sb = world();
    (sb.tables.v_gl_entries as Row[]).push(
      gl('JE-U', '2026-07-20', 'SOPAY', 'pay-u', '310-0010', 'CASH AT BANK - MAYBANK', 7000, 0),
      gl('JE-U', '2026-07-20', 'SOPAY', 'pay-u', '300-0000', 'ACCOUNT RECEIVEABLE', 0, 7000, { party_type: 'CUSTOMER', party_name: 'AH MENG' }),
    );
    (sb.tables.mfg_sales_order_payments as Row[]).push({ company_id: CO, id: 'pay-u', so_doc_no: 'SO-3', amount_sen: 7000, paid_at: '2026-07-20', created_at: '2026-07-20T03:00:00Z' });
    const r = await fetchReport(harness(sb), 'from=2026-07-01&to=2026-07-31&party=1');
    /* The bank receipts: one row, both casings in it (the card swipe keeps its own row by design). */
    const bankRows = r.receipts.filter((x) => x.key.startsWith('300-0000:') && !x.key.includes(':CARD'));
    expect(bankRows.map((x) => x.key)).toEqual(['300-0000:AH MENG']);
    expect(cell(r.receipts, '300-0000:AH MENG', '310-0010')).toBe(50000 + 7000);
  });

  test('party=1 names the control rows by debtor/creditor and does not split the supplier payment', async () => {
    const r = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31&party=1');
    /* The name keys a row case-blind (owner 2026-11-09: Finance's words are upper case from now on; older lines are not). */
    expect(r.receipts.find((x) => x.key === '300-0000:AH MENG')?.name).toBe('Ah Meng · ACCOUNT RECEIVEABLE');
    expect(cell(r.payments, '400-0000:FOSHAN CHAIRS', '310-0010')).toBe(100000);
    expect(r.payments.find((x) => x.key === '601-0003')).toBeUndefined();
    expect(r.totals.payments['310-0010']).toBe(125000); // the same money, differently named
  });

  test('an account filter narrows the columns; the other money account then reads as a transfer counterpart', async () => {
    const r = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31&accounts=320-0000');
    expect(r.columns.map((c) => c.code)).toEqual(['320-0000']);
    expect(cell(r.receipts, 'XFER:310-0010', '320-0000')).toBe(20000);
    expect(r.totals.closing).toEqual({ '320-0000': 14000 });
  });

  test('a bad range is refused', async () => {
    const res = await harness(world()).request('/accounting/reports/receipts-payments?from=2026-07-31&to=2026-07-01');
    expect(res.status).toBe(400);
  });

  /* The rows on the report's tree (docs/bugs/0912): the chart's own — one
     section layer over the codes. What is pinned: a coded row sits where
     its code sits with its figure per column, a category sums per column; a
     transfer between two of the report's own columns is off the tree (owner
     2026-11-05: 完全不显示) and money paid ahead of a bill sits on the creditor
     control; In lines are % of the first In category (Total Cash In), Out
     lines % of the out side. */
  test('the rows come back on the Cash Flow tree: own-account transfers off it, the advance on the creditor control', async () => {
    const r = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31') as Report & {
      layout: { stored: boolean; tree: Laid[]; inSen: number; outSen: number };
    };
    expect(r.layout.stored).toBe(false);
    expect(r.layout.tree.map((n) => [n.kind, n.id, n.flow, n.totalLabel, n.amountSen])).toEqual([
      ['category', 'side:in', 'in', 'Total receipts', 80000],
      ['category', 'side:out', 'out', 'Total payments', 111000],
      ['unassigned', 'unassigned:out', 'out', 'Total unassigned payments', 300],
    ]);
    /* The transfer moved 200.00 between the two columns: the tree drops it on both sides, so in − out still equals receipts − payments. */
    expect(r.layout.inSen - r.layout.outSen).toBe(r.totals.receiptsTotalSen - r.totals.paymentsTotalSen);
    const [receipts, payments] = r.layout.tree as [Laid, Laid];
    expect(receipts.children.map((n) => [n.label, n.amountSen, n.pct, n.children.map((k) => [k.key, k.amountSen, k.pct])])).toEqual([
      ['CURRENT ASSETS', 80000, 100, [[undefined, 50000, 62.5], [undefined, 30000, 37.5]]],
    ]);
    const byLabel = (label: string) => payments.children.find((n) => n.label === label)!;
    expect(payments.children.some((n) => n.children.some((k) => String(k.key).startsWith('XFER:')))).toBe(false);
    expect(byLabel('CURRENT LIABILITIES').children.map((n) => [n.key, n.label, n.cells])).toEqual([
      ['400-0000', '400-0000 · ACCOUNT PAYABLE', { '310-0010': 30000 }],
    ]);
    expect(byLabel('COST OF GOODS SOLD').children.map((n) => n.key)).toEqual(['601-0001', '601-0003']);
    expect(byLabel('COST OF GOODS SOLD').cells).toEqual({ '310-0010': 70000 });
    expect(byLabel('EXPENSES').cells).toEqual({ '310-0010': 5000, '320-0000': 6000 });
    /* % of the out side: 700.00 of 1,113.00 (the card fee is out too). */
    expect(byLabel('COST OF GOODS SOLD').pct).toBe(62.9);
  });

  test('by party, the control account\'s rows print together where the control sits', async () => {
    const r = await fetchReport(harness(world()), 'from=2026-07-01&to=2026-07-31&party=1') as Report & { layout: { tree: Laid[] } };
    const liabilities = r.layout.tree[1]!.children.find((n) => n.label === 'CURRENT LIABILITIES')!;
    const keys = liabilities.children.map((n) => [n.key, n.label]);
    expect(keys).toContainEqual(['400-0000:FOSHAN CHAIRS', 'FOSHAN CHAIRS · ACCOUNT PAYABLE']);
    expect(keys).toContainEqual(['405-0000:HOUZS VENTURE', 'HOUZS VENTURE · OTHER CREDITORS']);
  });
});
type Laid = { kind: string; id: string; key?: string; label: string; flow?: string; totalLabel?: string; amountSen: number; pct: number | null; cells?: Record<string, number>; children: Laid[] };
