/* The deposit invoice's cost (owner 2026-11-26: 「记」, as AutoCount booked its
   deposit sales). Made-up figures. Pinned:
     • a company with deposit_cost_pct books that share of each deposit invoice
       as cost on the invoice's own entry — Dr 619-0000 / Cr 410-0080 — and
       records it on the invoice; a company without books the sale alone (0);
     • the final invoice's note releases it — Dr 410-0080 / Cr 619-0000 — so
       both accounts net to nothing once the deposit is taken back;
     • notes that take a deposit back in parts release exactly its cost
       between them;
     • an invoice posted before its company booked a cost is posted again with
       it — the old entry reversed on its own day — and one a note already
       stands against is left alone.
   Same fake-PostgREST harness as tests/depositInvoiceCloseout.test.ts. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { bookSoPaymentBestEffort } from '../src/scm/lib/so-payment-row';
import { postSiRevenue } from '../src/scm/lib/post-si-revenue';
import { repostDepositInvoiceCost } from '../src/acc/deposit-invoices';
import { depositCostReleaseSen, depositCostSen } from '../src/acc/deposit-cost';

const CO = 2;
const SO = '2990-SO-2609-001';
const SI = '2990-SI-2609-001';
const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }),
  acct('320-0000', 'CASH IN HAND', 'ASSET'),
  acct('410-0080', 'ACCRUAL - COST OF GOOD SOLD', 'LIABILITY'),
  acct('500-0003', 'SALES OF SOFA', 'INCOME'),
  acct('509-0000', 'DEPOSIT PAY BY CUSTOMER', 'INCOME'),
  acct('510-0000', 'RETURN INWARDS', 'INCOME'),
  acct('619-0000', 'COST OF PURCHASE BASED ON DEPOSIT (34%)', 'EXPENSE'),
];

function harness(costPct: number | null) {
  return fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    companies: [{ id: CO, code: '2990', name: '2990' }],
    acc_account_roles: [],
    acc_company_settings: [{ company_id: CO, deposit_invoice_enabled: true, deposit_invoice_from: '2026-09-01', deposit_cost_pct: costPct }],
    acc_item_group_accounts: [{ company_id: CO, group_code: 'SOFA', sales_account: '500-0003', purchase_account: '601-0003' }],
    mfg_sales_orders: [{ doc_no: SO, company_id: CO, status: 'DELIVERED', debtor_code: null, debtor_name: 'Larding Chen', customer_id: 'cust-larding' }],
    mfg_sales_order_payments: [],
    sales_invoices: [],
    sales_invoice_items: [],
    acc_deposit_invoices: [], acc_credit_notes: [], acc_credit_note_lines: [],
    journal_entries: [], journal_entry_lines: [],
  }, {}, [], ['journal_entry_lines']);
}
type Sb = ReturnType<typeof harness>;
const payment = (id: string, amountSen: number, paidAt: string): Row => ({
  id, so_doc_no: SO, paid_at: paidAt, method: 'cash', merchant_provider: null, amount_sen: amountSen, created_by: 'u-1', company_id: CO,
});
const dis = (sb: Sb) => sb.tables.acc_deposit_invoices as Row[];
const jes = (sb: Sb) => sb.tables.journal_entries as Row[];
const linesOf = (sb: Sb, jeNo: string) => {
  const je = jes(sb).find((j) => j.je_no === jeNo)!;
  return (sb.tables.journal_entry_lines as Row[]).filter((l) => l.journal_entry_id === je.id)
    .map((l) => ({ code: l.account_code, dr: Number(l.debit_sen), cr: Number(l.credit_sen), party: l.party_code ?? null }));
};
/* What an account holds across the entries that still stand (a reversed entry and its contra both left out). */
const standing = (sb: Sb, code: string) => {
  const out = new Set(jes(sb).filter((j) => j.reversed === true || String(j.source_type).endsWith('_REVERSAL')).map((j) => j.id));
  return (sb.tables.journal_entry_lines as Row[]).filter((l) => l.account_code === code && !out.has(l.journal_entry_id))
    .reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0);
};
async function twoDeposits(sb: Sb) {
  await bookSoPaymentBestEffort(sb, payment('p-1', 100_000, '2026-09-02'), 'payment');
  await bookSoPaymentBestEffort(sb, payment('p-2', 50_000, '2026-09-05'), 'payment');
}
function finalInvoice(sb: Sb) {
  (sb.tables.sales_invoices as Row[]).push({
    id: 'si-1', company_id: CO, invoice_number: SI, so_doc_no: SO, status: 'SENT', invoice_date: '2026-10-10',
    debtor_code: null, debtor_name: 'Larding Chen', total_sen: 300_000, paid_sen: 0, migrated_no_stock: false,
  });
  (sb.tables.sales_invoice_items as Row[]).push({ id: 'sii-1', company_id: CO, sales_invoice_id: 'si-1', item_group: 'sofa', line_total_sen: 300_000 });
}

describe('the cost on the deposit invoice', () => {
  test('34% of each deposit booked on the invoice\'s own entry, Dr 619-0000 / Cr 410-0080, and recorded on the invoice', async () => {
    const sb = harness(34);
    await twoDeposits(sb);
    expect(dis(sb).map((d) => [d.di_number, d.amount_sen, d.cost_sen])).toEqual([
      ['2990-DI-2609-001', 100_000, 34_000],
      ['2990-DI-2609-002', 50_000, 17_000],
    ]);
    expect(linesOf(sb, String(dis(sb)[0]!.je_no))).toEqual([
      { code: '300-0000', dr: 100_000, cr: 0, party: 'cust-larding' },
      { code: '509-0000', dr: 0, cr: 100_000, party: null },
      { code: '619-0000', dr: 34_000, cr: 0, party: null },
      { code: '410-0080', dr: 0, cr: 34_000, party: null },
    ]);
  });

  test('a company that books no cost posts the sale alone and records 0', async () => {
    const sb = harness(null);
    await twoDeposits(sb);
    expect(dis(sb).map((d) => d.cost_sen)).toEqual([0, 0]);
    expect(linesOf(sb, String(dis(sb)[0]!.je_no)).map((l) => l.code)).toEqual(['300-0000', '509-0000']);
  });
});

describe('the release', () => {
  test('the final invoice\'s notes release each invoice\'s cost, Dr 410-0080 / Cr 619-0000, and both accounts net to nothing', async () => {
    const sb = harness(34);
    await twoDeposits(sb);
    finalInvoice(sb);
    expect(await postSiRevenue(sb, SI)).toMatchObject({ ok: true, status: 'posted' });
    const cn1 = jes(sb).find((j) => j.source_type === 'CN' && j.source_doc_no === '2990-CN-2610-001')!;
    expect(cn1.entry_date).toBe('2026-10-10');
    expect(linesOf(sb, String(cn1.je_no))).toEqual([
      { code: '509-0000', dr: 100_000, cr: 0, party: null },
      { code: '300-0000', dr: 0, cr: 100_000, party: 'cust-larding' },
      { code: '410-0080', dr: 34_000, cr: 0, party: null },
      { code: '619-0000', dr: 0, cr: 34_000, party: null },
    ]);
    expect(standing(sb, '619-0000')).toBe(0);
    expect(standing(sb, '410-0080')).toBe(0);
  });

  test('a note on an invoice that booked no cost releases nothing', async () => {
    const sb = harness(null);
    await twoDeposits(sb);
    finalInvoice(sb);
    await postSiRevenue(sb, SI);
    const cn1 = jes(sb).find((j) => j.source_type === 'CN')!;
    expect(linesOf(sb, String(cn1.je_no)).map((l) => l.code)).toEqual(['509-0000', '300-0000']);
  });

  test('notes taking a deposit back in parts release exactly its cost between them', () => {
    const costSen = depositCostSen(10_000, 34);
    expect(costSen).toBe(3_400);
    const parts = [3_333, 3_333, 3_334];
    let prior = 0;
    const released = parts.map((thisSen) => {
      const r = depositCostReleaseSen({ costSen, amountSen: 10_000, priorSen: prior, thisSen });
      prior += thisSen;
      return r;
    });
    expect(released).toEqual([1_133, 1_133, 1_134]);
    expect(released.reduce((s, r) => s + r, 0)).toBe(costSen);
    expect(depositCostReleaseSen({ costSen, amountSen: 10_000, priorSen: 10_000, thisSen: 500 })).toBe(0);
    expect(depositCostReleaseSen({ costSen: 0, amountSen: 10_000, priorSen: 0, thisSen: 10_000 })).toBe(0);
  });
});

describe('posting an older invoice again with its cost', () => {
  test('the old entry is reversed on its own day, the new one carries the cost, the invoice records it; a second run changes nothing', async () => {
    const sb = harness(null);
    await twoDeposits(sb);
    const oldJe = String(dis(sb)[0]!.je_no);
    (sb.tables.acc_company_settings as Row[])[0]!.deposit_cost_pct = 34;
    const r = await repostDepositInvoiceCost(sb, { companyId: CO, diNumber: '2990-DI-2609-001' });
    expect(r).toMatchObject({ ok: true, status: 'reposted', oldJeNo: oldJe, costSen: 34_000 });
    const di = dis(sb)[0]!;
    expect(di.cost_sen).toBe(34_000);
    expect(di.je_no).not.toBe(oldJe);
    const old = jes(sb).find((j) => j.je_no === oldJe)!;
    expect(old.reversed).toBe(true);
    const contra = jes(sb).find((j) => j.source_type === 'DI_REVERSAL')!;
    expect(contra.entry_date).toBe('2026-09-02');
    const fresh = jes(sb).find((j) => j.je_no === di.je_no)!;
    expect([fresh.entry_date, fresh.source_type, fresh.source_doc_no, fresh.reversed ?? false]).toEqual(['2026-09-02', 'DI', '2990-DI-2609-001', false]);
    expect(linesOf(sb, String(di.je_no)).map((l) => [l.code, l.dr, l.cr])).toEqual([
      ['300-0000', 100_000, 0], ['509-0000', 0, 100_000], ['619-0000', 34_000, 0], ['410-0080', 0, 34_000],
    ]);
    expect(standing(sb, '509-0000')).toBe(-150_000);
    expect(standing(sb, '619-0000')).toBe(34_000);
    expect(await repostDepositInvoiceCost(sb, { companyId: CO, diNumber: '2990-DI-2609-001' })).toEqual({ ok: true, status: 'not_needed', why: 'its cost is already recorded' });
  });

  test('an invoice a note already stands against is left alone; a company booking no cost is refused', async () => {
    const sb = harness(null);
    await twoDeposits(sb);
    finalInvoice(sb);
    await postSiRevenue(sb, SI);
    (sb.tables.acc_company_settings as Row[])[0]!.deposit_cost_pct = 34;
    expect(await repostDepositInvoiceCost(sb, { companyId: CO, diNumber: '2990-DI-2609-001' })).toEqual({ ok: true, status: 'noted', why: 'a note stands against it (2990-CN-2610-001)' });
    const none = harness(null);
    await twoDeposits(none);
    expect(await repostDepositInvoiceCost(none, { companyId: CO, diNumber: '2990-DI-2609-001' })).toEqual({ ok: false, reason: 'company 2 books no deposit cost' });
  });
});
