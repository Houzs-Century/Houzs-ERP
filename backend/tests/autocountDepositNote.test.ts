/* The AutoCount deposit note: AutoCount counted the deposit as sales and booked
   34% of it as cost (owner 2026-11-25); the ERP takes it back out of sales by a
   credit note on an account of its own (owner 2026-11-26: 「从sales 扣回来，但是是
   开cn 的方式吧，account 不要放在sales 那边一起」). Pinned, with made-up figures:
     • the order's first sales invoice dated after the books' opening day raises
       ONE posted credit note for the order's AutoCount money — CN, dated the
       invoice day, Dr DEPOSIT SALES BOOKED IN AUTOCOUNT 511-0000 (SALES
       ADJUSTMENTS) / Cr AR (the invoice's party), its entry also Dr 410-0080 /
       Cr 619-0000 for 34% of it, source document AUTOCOUNT DEPOSIT, linked to
       the invoice;
     • the order's later invoice, and a re-post, raise nothing beside it;
     • money AutoCount took after the opening day (a balance the second import
       dated 1-7 Sep), a soft-launch invoice, a company with no books start and
       a migrated invoice raise nothing;
     • a balance AutoCount's own record shows paid by the opening day, though
       the import dated it later, goes on the note when the caller passes the
       amount (owner 2026-11-26) — never more than the order's AutoCount money;
     • an order AutoCount invoiced before the books, whose ERP invoice bills
       RM 0, gets no note (owner 2026-11-26);
     • a cancelled invoice cancels its note by contra, and the note is raised
       again, for the same amount, on the order's next live invoice;
     • the note is a deposit paper: it knocks nothing off.
   Same fake-PostgREST harness as tests/depositInvoiceCloseout.test.ts. */

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { postSiRevenue } from '../src/scm/lib/post-si-revenue';
import {
  AUTOCOUNT_DEPOSIT_REF, applyAutoCountDepositToInvoice, autoCountDepositSen, isAutoCountDepositNote,
  releaseAutoCountDepositFromInvoice,
} from '../src/acc/autocount-deposits';
import { depositPaperRefusal, depositPapers } from '../src/acc/credit-note-si';
import { autoCountCostSen } from '../src/acc/autocount-deposit-note';

const CO = 1;
const SO = 'HC-SO-000101';
const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }),
  acct('410-0080', 'ACCRUAL - COST OF GOOD SOLD', 'LIABILITY'),
  acct('500-0003', 'SALES OF SOFA', 'INCOME'),
  acct('509-0000', 'DEPOSIT PAY BY CUSTOMER', 'INCOME'),
  acct('511-0000', 'DEPOSIT SALES BOOKED IN AUTOCOUNT', 'INCOME'),
  acct('619-0000', 'COST OF PURCHASE BASED ON DEPOSIT (34%)', 'EXPENSE'),
];
const OPENED = { company_id: CO, books_start_date: '2026-09-01', opening_stock: null, opening_locked_at: null, opening_locked_by: null };

function harness(over: { settings?: Row[]; payments?: Row[] } = {}) {
  return fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    companies: [{ id: CO, code: 'HOUZS', name: 'Houzs' }],
    acc_account_roles: [],
    acc_company_settings: (over.settings ?? [OPENED]).map((r) => ({ ...r })),
    acc_item_group_accounts: [{ company_id: CO, group_code: 'SOFA', sales_account: '500-0003', purchase_account: '601-0003' }],
    mfg_sales_orders: [{ doc_no: SO, company_id: CO, status: 'DELIVERED', debtor_code: '300-C002', debtor_name: 'Mei Ling', customer_id: 'cust-1', linked_ac_docno: 'SO-000101' }],
    mfg_sales_order_payments: (over.payments ?? [
      /* Taken in AutoCount (the row carries the order's date), and one in the ERP. */
      { id: 'p-ac', company_id: CO, so_doc_no: SO, method: 'imported', amount_sen: 120_000, paid_at: '2026-03-14' },
      { id: 'p-erp', company_id: CO, so_doc_no: SO, method: 'cash', amount_sen: 30_000, paid_at: '2026-09-08' },
    ]).map((r) => ({ ...r })),
    sales_invoices: [],
    sales_invoice_items: [],
    acc_deposit_invoices: [], acc_credit_notes: [], acc_credit_note_lines: [], acc_credit_note_allocations: [],
    journal_entries: [], journal_entry_lines: [],
  }, {}, [], ['journal_entry_lines']);
}
type Sb = ReturnType<typeof harness>;

function invoice(sb: Sb, id: string, number: string, date: string, totalSen: number, over: Row = {}) {
  (sb.tables.sales_invoices as Row[]).push({
    id, company_id: CO, invoice_number: number, so_doc_no: SO, status: 'SENT', invoice_date: date,
    debtor_code: '300-C002', debtor_name: 'Mei Ling', total_sen: totalSen, paid_sen: 0, migrated_no_stock: false, ...over,
  });
  (sb.tables.sales_invoice_items as Row[]).push({ id: `${id}-1`, company_id: CO, sales_invoice_id: id, item_group: 'sofa', line_total_sen: totalSen });
}
const notes = (sb: Sb) => sb.tables.acc_credit_notes as Row[];
const jes = (sb: Sb) => sb.tables.journal_entries as Row[];
const linesOf = (sb: Sb, jeNo: string) => {
  const je = jes(sb).find((j) => j.je_no === jeNo)!;
  return (sb.tables.journal_entry_lines as Row[]).filter((l) => l.journal_entry_id === je.id)
    .map((l) => ({ code: l.account_code, dr: Number(l.debit_sen), cr: Number(l.credit_sen), party: l.party_code ?? null }));
};
/* Net of every posted entry on an account, debit less credit — the ledger's
   view (scm.v_gl_entries): a cancelled note's entry and its contra both count. */
const net = (sb: Sb, code: string) => {
  const live = new Set(jes(sb).filter((j) => j.posted).map((j) => j.id));
  return (sb.tables.journal_entry_lines as Row[]).filter((l) => l.account_code === code && live.has(l.journal_entry_id))
    .reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0);
};

describe('the AutoCount deposit at the order\'s invoice', () => {
  test('the first invoice after the opening day raises one posted note: Dr 511-0000 / Cr AR (the invoice\'s party) and 34% cost released, dated the invoice, for the AutoCount money only', async () => {
    const sb = harness();
    invoice(sb, 'si-1', 'HC-SI-2609-001', '2026-09-20', 200_000);
    expect(await postSiRevenue(sb, 'HC-SI-2609-001')).toMatchObject({ ok: true, status: 'posted', totalSen: 200_000 });
    expect(notes(sb).map((n) => [n.note_number, n.kind, n.status, n.sales_invoice_id, n.so_doc_no, n.source_doc_no, n.note_date, n.total_sen, n.party_code, n.party_name])).toEqual([
      ['HC-CN-2609-001', 'CN', 'POSTED', 'si-1', SO, AUTOCOUNT_DEPOSIT_REF, '2026-09-20', 120_000, '300-C002', 'Mei Ling'],
    ]);
    expect((sb.tables.acc_credit_note_lines as Row[]).map((l) => [l.account_code, l.amount_sen, l.description])).toEqual([
      ['511-0000', 120_000, `Deposit paid in AutoCount (SO-000101) on ${SO}, applied to HC-SI-2609-001`],
    ]);
    const cn = jes(sb).find((j) => j.source_type === 'CN')!;
    expect(cn.entry_date).toBe('2026-09-20');
    expect(linesOf(sb, String(cn.je_no))).toEqual([
      { code: '511-0000', dr: 120_000, cr: 0, party: null },
      { code: '300-0000', dr: 0, cr: 120_000, party: '300-C002' },
      { code: '410-0080', dr: 40_800, cr: 0, party: null },
      { code: '619-0000', dr: 0, cr: 40_800, party: null },
    ]);
    /* The invoice +200,000, the AutoCount deposit −120,000: the customer owes
       80,000 here (the ERP's own 30,000 books through its own SOPAY). Sales:
       the invoice's 200,000 less the 120,000 AutoCount already counted, apart
       from the SALES accounts; cost: 34% of it back out of cost. */
    expect(net(sb, '300-0000')).toBe(80_000);
    expect(net(sb, '500-0003')).toBe(-200_000);
    expect(net(sb, '511-0000')).toBe(120_000);
    expect(net(sb, '509-0000')).toBe(0);
    expect(net(sb, '410-0080')).toBe(40_800);
    expect(net(sb, '619-0000')).toBe(-40_800);
    expect(net(sb, '440-0000')).toBe(0);
  });

  test('the order\'s next invoice and a re-post raise nothing beside it', async () => {
    const sb = harness();
    invoice(sb, 'si-1', 'HC-SI-2609-001', '2026-09-20', 100_000);
    invoice(sb, 'si-2', 'HC-SI-2610-004', '2026-10-03', 100_000);
    await postSiRevenue(sb, 'HC-SI-2609-001');
    expect(await postSiRevenue(sb, 'HC-SI-2610-004')).toMatchObject({ ok: true, status: 'posted' });
    expect(await postSiRevenue(sb, 'HC-SI-2609-001')).toMatchObject({ ok: true, status: 'already_posted' });
    expect(notes(sb).map((n) => [n.note_number, n.sales_invoice_id, n.total_sen])).toEqual([['HC-CN-2609-001', 'si-1', 120_000]]);
  });

  test('money AutoCount took after the opening day, a soft-launch invoice, no books start and a migrated invoice raise nothing', async () => {
    /* The balance the second import found settled, dated by the order's last
       edit in AutoCount (1-7 Sep): September money, not on the note. */
    const later = harness({ payments: [
      { id: 'p-ac', company_id: CO, so_doc_no: SO, method: 'imported', amount_sen: 120_000, paid_at: '2026-03-14' },
      { id: 'p-ac2', company_id: CO, so_doc_no: SO, method: 'imported', amount_sen: 40_000, paid_at: '2026-09-03' },
    ] });
    invoice(later, 'si-1', 'HC-SI-2609-001', '2026-09-20', 200_000);
    await postSiRevenue(later, 'HC-SI-2609-001');
    expect(notes(later).map((n) => n.total_sen)).toEqual([120_000]);

    const soft = harness();
    invoice(soft, 'si-0', 'HC-SI-2608-009', '2026-08-30', 200_000);
    expect(await postSiRevenue(soft, 'HC-SI-2608-009')).toMatchObject({ ok: true, status: 'posted' });
    expect(notes(soft)).toHaveLength(0);

    const unopened = harness({ settings: [] });
    invoice(unopened, 'si-1', 'HC-SI-2609-001', '2026-09-20', 200_000);
    expect(await postSiRevenue(unopened, 'HC-SI-2609-001')).toMatchObject({ ok: true, status: 'posted' });
    expect(notes(unopened)).toHaveLength(0);

    const migrated = harness();
    invoice(migrated, 'si-m', 'HC-SI-2609-002', '2026-09-20', 200_000, { migrated_no_stock: true });
    expect(await postSiRevenue(migrated, 'HC-SI-2609-002')).toEqual({ ok: true, status: 'migrated_source' });
    expect(notes(migrated)).toHaveLength(0);

    const none = harness({ payments: [{ id: 'p-erp', company_id: CO, so_doc_no: SO, method: 'cash', amount_sen: 30_000, paid_at: '2026-09-08' }] });
    invoice(none, 'si-1', 'HC-SI-2609-001', '2026-09-20', 200_000);
    await postSiRevenue(none, 'HC-SI-2609-001');
    expect(notes(none)).toHaveLength(0);
  });

  test('a cancelled invoice cancels its note by contra and the note is raised again on the order\'s next live invoice', async () => {
    const sb = harness();
    invoice(sb, 'si-1', 'HC-SI-2609-001', '2026-09-20', 100_000);
    /* An RM 0 invoice bills nothing and posts nothing: the note never moves onto it. */
    invoice(sb, 'si-0', 'HC-SI-2609-007', '2026-09-25', 0);
    invoice(sb, 'si-2', 'HC-SI-2610-004', '2026-10-03', 100_000);
    await postSiRevenue(sb, 'HC-SI-2609-001');
    await postSiRevenue(sb, 'HC-SI-2610-004');
    (sb.tables.sales_invoices as Row[]).find((s) => s.id === 'si-1')!.status = 'CANCELLED';
    const r = await releaseAutoCountDepositFromInvoice(sb, { companyId: CO, siId: 'si-1', actor: 'Chew' });
    expect(r).toEqual({ ok: true, released: ['HC-CN-2609-001'], movedTo: 'HC-CN-2610-001' });
    expect(notes(sb).map((n) => [n.note_number, n.status, n.sales_invoice_id, n.note_date, n.total_sen])).toEqual([
      ['HC-CN-2609-001', 'CANCELLED', 'si-1', '2026-09-20', 120_000],
      ['HC-CN-2610-001', 'POSTED', 'si-2', '2026-10-03', 120_000],
    ]);
    expect(net(sb, '511-0000')).toBe(120_000);
    expect(net(sb, '619-0000')).toBe(-40_800);

    /* The last live invoice cancelled: the deposit is back in sales, its cost back in cost. */
    (sb.tables.sales_invoices as Row[]).find((s) => s.id === 'si-2')!.status = 'CANCELLED';
    expect(await releaseAutoCountDepositFromInvoice(sb, { companyId: CO, siId: 'si-2', actor: 'Chew' }))
      .toEqual({ ok: true, released: ['HC-CN-2610-001'], movedTo: null });
    expect(net(sb, '511-0000')).toBe(0);
    expect(net(sb, '410-0080')).toBe(0);
    expect(net(sb, '619-0000')).toBe(0);
    expect(await releaseAutoCountDepositFromInvoice(sb, { companyId: CO, siId: 'si-2', actor: 'Chew' }))
      .toEqual({ ok: true, released: [], movedTo: null });
  });

  test('a balance AutoCount settled by the opening day, though the import dated it later, goes on the note when the amount is passed, and stays on it when the note moves', async () => {
    const sb = harness({ payments: [
      { id: 'p-ac', company_id: CO, so_doc_no: SO, method: 'imported', amount_sen: 120_000, paid_at: '2026-03-14' },
      { id: 'p-bal', company_id: CO, so_doc_no: SO, method: 'imported', amount_sen: 40_000, paid_at: '2026-09-07' },
    ] });
    invoice(sb, 'si-1', 'HC-SI-2609-001', '2026-09-20', 200_000);
    invoice(sb, 'si-2', 'HC-SI-2610-004', '2026-10-03', 100_000);
    const at = { companyId: CO, siId: 'si-1', siNumber: 'HC-SI-2609-001', soDocNo: SO, invoiceDate: '2026-09-20', party: { code: '300-C002', name: 'Mei Ling' }, actor: 'Chew' };
    /* Never more than the order's AutoCount money, whatever its date. */
    expect(await applyAutoCountDepositToInvoice(sb, { ...at, amountSen: 160_001 })).toMatchObject({ ok: false });
    expect(notes(sb)).toHaveLength(0);
    expect(await applyAutoCountDepositToInvoice(sb, { ...at, amountSen: 160_000 })).toMatchObject({ ok: true, status: 'raised', amountSen: 160_000 });
    expect(notes(sb).map((n) => [n.note_number, n.sales_invoice_id, n.total_sen])).toEqual([['HC-CN-2609-001', 'si-1', 160_000]]);
    expect(net(sb, '511-0000')).toBe(160_000);
    expect(net(sb, '619-0000')).toBe(-54_400);

    /* The invoice cancelled: the note moves to the next invoice with its whole
       amount, not the 120,000 the dates alone would give. */
    (sb.tables.sales_invoices as Row[]).find((s) => s.id === 'si-1')!.status = 'CANCELLED';
    expect(await releaseAutoCountDepositFromInvoice(sb, { companyId: CO, siId: 'si-1', actor: 'Chew' }))
      .toEqual({ ok: true, released: ['HC-CN-2609-001'], movedTo: 'HC-CN-2610-001' });
    expect(notes(sb).map((n) => [n.note_number, n.status, n.sales_invoice_id, n.total_sen])).toEqual([
      ['HC-CN-2609-001', 'CANCELLED', 'si-1', 160_000],
      ['HC-CN-2610-001', 'POSTED', 'si-2', 160_000],
    ]);
    expect(net(sb, '511-0000')).toBe(160_000);
    expect(net(sb, '619-0000')).toBe(-54_400);
  });

  test('an order AutoCount invoiced before the books, whose ERP invoice bills RM 0, gets no note', async () => {
    const sb = harness();
    invoice(sb, 'si-ac', 'HC-I-2608-0007', '2026-08-29', 150_000, { migrated_no_stock: true });
    invoice(sb, 'si-0', 'HC-SI-2609-003', '2026-09-05', 0);
    expect(await postSiRevenue(sb, 'HC-SI-2609-003')).toEqual({ ok: false, status: 'zero_total' });
    const at = { companyId: CO, siId: 'si-0', siNumber: 'HC-SI-2609-003', soDocNo: SO, invoiceDate: '2026-09-05', party: { code: '300-C002', name: 'Mei Ling' }, actor: 'Chew' };
    expect(await applyAutoCountDepositToInvoice(sb, { ...at, amountSen: null })).toMatchObject({ ok: true, status: 'nothing' });
    expect(await applyAutoCountDepositToInvoice(sb, { ...at, amountSen: 120_000 })).toMatchObject({ ok: true, status: 'nothing' });
    expect(notes(sb)).toHaveLength(0);
    expect(jes(sb)).toHaveLength(0);
  });

  test('the note is a deposit paper: it knocks nothing off, said in its own words', async () => {
    const sb = harness();
    invoice(sb, 'si-1', 'HC-SI-2609-001', '2026-09-20', 200_000);
    await postSiRevenue(sb, 'HC-SI-2609-001');
    const papers = await depositPapers(sb, CO, notes(sb));
    expect(papers).toEqual({ ok: true, value: new Map([[String(notes(sb)[0]!.id), { kind: 'autocount', di: null }]]) });
    expect(depositPaperRefusal('HC-CN-2609-001', { kind: 'autocount', di: null })).toContain('deposit paid in AutoCount');
  });
});

describe('what counts as the AutoCount deposit', () => {
  test('imported rows above nought, dated on or before the opening day', () => {
    expect(autoCountDepositSen([
      { method: 'imported', amount_sen: 50_000, paid_at: '2025-12-01' },
      { method: 'imported', amount_sen: 25_000, paid_at: '2026-08-31' },
      { method: 'imported', amount_sen: 9_000, paid_at: '2026-09-01' },
      { method: 'imported', amount_sen: -5_000, paid_at: '2026-08-01' },
      { method: 'imported', amount_sen: 7_000, paid_at: null },
      { method: 'cash', amount_sen: 11_000, paid_at: '2026-08-01' },
    ], '2026-08-31')).toBe(75_000);
  });

  test('the cost it releases is 34% of the deposit, in whole sen', () => {
    expect(autoCountCostSen(120_000)).toBe(40_800);
    expect(autoCountCostSen(5)).toBe(2);
    expect(autoCountCostSen(1)).toBe(0);
  });

  test('the note is known by its source document, whatever its case', () => {
    expect(isAutoCountDepositNote({ kind: 'CN', source_doc_no: 'AUTOCOUNT DEPOSIT' })).toBe(true);
    expect(isAutoCountDepositNote({ kind: 'CN', source_doc_no: ' autocount deposit ' })).toBe(true);
    expect(isAutoCountDepositNote({ kind: 'DN', source_doc_no: 'AUTOCOUNT DEPOSIT' })).toBe(false);
    expect(isAutoCountDepositNote({ kind: 'CN', source_doc_no: 'HC-DI-2609-001' })).toBe(false);
    expect(isAutoCountDepositNote(null)).toBe(false);
  });
});
