// Finance's To do — the design's built-in rules (Finance-1a-To-do, owner's
// Claude Design redesign 2026-11-02): which facts raise which job, whose desk
// it is on, how long it has waited, and the month's checklist.

import { describe, it, expect } from 'vitest';
import { addDays, bankName, buildFinanceTodo, raiseJobs, type TodoFacts, type TodoViewer } from './finance-todo';

const TODAY = '2026-11-02';

const facts = (over: Partial<TodoFacts> = {}): TodoFacts => ({
  today: TODAY,
  acquirers: [],
  lastReportTo: {},
  keyedCardDays: {},
  cardRows: [],
  bankAccounts: [],
  lastStatementTo: {},
  bankLines: [],
  lockedLastMonth: [],
  requests: [],
  vouchers: [],
  transfers: [],
  overdue: [],
  money: null,
  done: [],
  problems: [],
  ...over,
});

const FINANCE: TodoViewer = { finance: true, checker: true, approver: true, checkerNames: [], approverNames: [] };

describe('merchant reports', () => {
  const MBB = { code: 'MBB', name: 'MBB', hasUniqueRef: true };
  const GHL = { code: 'GHL', name: 'GHL', hasUniqueRef: false };

  it('a report not in by the next morning is an upload, waiting since that morning', () => {
    const { mine } = raiseJobs(facts({ acquirers: [MBB], lastReportTo: { MBB: '2026-10-29' }, keyedCardDays: { MBB: ['2026-10-31', '2026-10-30'] } }), FINANCE);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      rule: 'card-missing', group: 'recon', sub: 'merchant', icon: 'upload', title: 'Upload MBB merchant report',
      detail: 'Swipes of 2026/10/30 – 2026/10/31 not in yet · their lines appear here after upload',
      since: '2026-10-31', action: { label: 'Upload', primary: true },
    });
  });

  it('no keyed swipes after the last report, no upload job', () => {
    expect(raiseJobs(facts({ acquirers: [MBB], lastReportTo: { MBB: '2026-11-01' } }), FINANCE).mine).toEqual([]);
  });

  it('matched lines are a Confirm, the rest a Choose — one job each per merchant, opened at the report', () => {
    const row = { acquirer: 'MBB', batchId: 7, byReference: true, txnDate: '2026-10-30', uploadedOn: '2026-10-31' };
    const { mine } = raiseJobs(facts({
      acquirers: [MBB],
      cardRows: [
        { ...row, bucket: 'MATCHED', grossSen: 10_000 },
        { ...row, bucket: 'MATCHED', grossSen: 2_550, txnDate: '2026-10-31' },
        { ...row, bucket: 'UNMATCHED', grossSen: 900, batchId: 8 },
        { ...row, bucket: 'NEEDS_CONFIRM', grossSen: 100 },
      ],
    }), FINANCE);
    const confirm = mine.find((j) => j.rule === 'card-matched');
    const choose = mine.find((j) => j.rule === 'card-choose');
    expect(confirm).toMatchObject({
      title: 'Confirm 2 merchant lines', amountSen: 12_550, since: '2026-10-31',
      detail: 'MBB report · swiped 2026/10/30 – 2026/10/31 · every line matched by reference',
      action: { label: 'Confirm', to: '/scm/merchant-recon?batch=7', primary: true },
    });
    expect(choose).toMatchObject({
      title: 'Choose payments for 2 MBB merchant lines', amountSen: 1_000,
      detail: 'MBB report · swiped 2026/10/30 · lines that fit more than one order, or none',
      action: { label: 'Open', to: '/scm/merchant-recon', primary: false },
    });
  });

  it('a merchant with no reference says each line is picked by amount and date', () => {
    const { mine } = raiseJobs(facts({
      acquirers: [GHL],
      cardRows: [{ acquirer: 'GHL', batchId: 3, bucket: 'UNMATCHED', byReference: false, grossSen: 5_000, txnDate: '2026-10-28', uploadedOn: '2026-10-29' }],
    }), FINANCE);
    expect(mine[0]?.title).toBe('Choose payments for 1 GHL merchant line');
    expect(mine[0]?.detail).toContain('GHL lines never match on their own, so each one is picked by amount and date');
  });
});

describe('bank statements', () => {
  const HLB = { accountCode: '310-0001', bankCode: 'HLB', accountName: 'HONG LEONG CA', createdOn: '2026-09-01' };
  const MBB = { accountCode: '310-0002', bankCode: 'MBB', accountName: 'MAYBANK CA', createdOn: '2026-10-29' };

  it('an account with no statement for three days is an upload', () => {
    const late = raiseJobs(facts({ bankAccounts: [HLB], lastStatementTo: { '310-0001': addDays(TODAY, -4) } }), FINANCE).mine;
    expect(late[0]).toMatchObject({
      rule: 'bank-missing', sub: 'bank', title: 'Upload Hong Leong statement', since: '2026-10-30',
      detail: '310-0001 HONG LEONG CA · the last upload stops at 2026/10/29 · 2026/10/30 onward is missing',
    });
    expect(raiseJobs(facts({ bankAccounts: [HLB], lastStatementTo: { '310-0001': addDays(TODAY, -3) } }), FINANCE).mine).toEqual([]);
  });

  it('a setup with no statement yet waits from the day it was set up', () => {
    const { mine } = raiseJobs(facts({ bankAccounts: [MBB], lastStatementTo: { '310-0002': null } }), FINANCE);
    expect(mine[0]).toMatchObject({ title: 'Upload Maybank statement', since: '2026-10-29', detail: '310-0002 MAYBANK CA · no statement uploaded yet' });
  });

  it('open lines are one Decide per account, the amount counted either way', () => {
    const { mine } = raiseJobs(facts({
      bankAccounts: [HLB], lastStatementTo: { '310-0001': TODAY },
      bankLines: [
        { accountCode: '310-0001', statementId: 4, amountSen: -12_000, periodTo: '2026-10-31', uploadedOn: '2026-11-01' },
        { accountCode: '310-0001', statementId: 4, amountSen: 3_000, periodTo: '2026-10-31', uploadedOn: '2026-11-01' },
      ],
    }), FINANCE);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      rule: 'bank-decide', title: 'Decide 2 Hong Leong lines', amountSen: 15_000, since: '2026-11-01',
      detail: '310-0001 · October statement · uploaded 2026/11/01', action: { label: 'Match', to: '/scm/bank-recon' },
    });
  });

  it('names a bank by its code, and keeps a code it does not know', () => {
    expect(bankName('mbb')).toBe('Maybank');
    expect(bankName('XYZ')).toBe('XYZ');
  });
});

describe('payments', () => {
  it('payment requests are one job, the payees listed, the oldest setting the wait', () => {
    const { mine } = raiseJobs(facts({
      requests: ['Kian', 'TNB', 'Ikhlas', 'Lim'].map((payee, i) => ({ payee, amountSen: 1_000 * (i + 1), createdOn: `2026-10-2${i}` })),
    }), FINANCE);
    expect(mine[0]).toMatchObject({
      rule: 'requests', title: 'Turn 4 payment requests into vouchers', detail: 'Kian · TNB · Ikhlas · +1 more',
      amountSen: 10_000, since: '2026-10-20', action: { to: '/scm/payment-requests?filter=waiting' },
    });
    expect(raiseJobs(facts({ requests: [{ payee: 'Kian', amountSen: 1, createdOn: TODAY }] }), FINANCE).mine[0]?.title)
      .toBe('Turn 1 payment request into a voucher');
  });

  it('a voucher to check or approve is on its desk; anyone else sees it waiting on that desk, by name', () => {
    const vouchers = [
      { stage: 'check' as const, payee: 'Kian', amountSen: 1_240_000, since: '2026-10-30', by: 'Daniel' },
      { stage: 'approve' as const, payee: 'Lim', amountSen: 118_000, since: '2026-10-31', by: 'Chew' },
    ];
    const finance = raiseJobs(facts({ vouchers }), { ...FINANCE, checker: true, approver: false, approverNames: ['Nico'] });
    expect(finance.mine.map((j) => j.rule)).toEqual(['pv-check']);
    expect(finance.mine[0]).toMatchObject({ title: 'Check 1 payment voucher', detail: 'Prepared by Daniel · Kian', action: { to: '/scm/payment-vouchers?status=PREPARED' } });
    expect(finance.others).toHaveLength(1);
    expect(finance.others[0]).toMatchObject({ rule: 'pv-approve', who: 'Nico', title: 'Approve 1 payment voucher', detail: 'Checked by Chew · Lim', action: { to: '/scm/payment-vouchers?status=CHECKED' } });

    const nobodyNamed = raiseJobs(facts({ vouchers }), { ...FINANCE, checker: false, approver: false });
    expect(nobodyNamed.others.map((j) => j.who)).toEqual(['Checker', 'Approver']);
  });
});

describe('receipts and invoices', () => {
  it('draft transfer receipts are one job to confirm the money arrived', () => {
    const { mine } = raiseJobs(facts({ transfers: [{ amountSen: 50_000, paidOn: '2026-10-25' }, { amountSen: 7_000, paidOn: null }] }), FINANCE);
    expect(mine[0]).toMatchObject({ rule: 'transfers', group: 'other', title: 'Confirm 2 transfers arrived', amountSen: 57_000, since: '2026-10-25' });
  });

  it('an invoice more than 30 days past due joins the list the day it crosses', () => {
    const { mine } = raiseJobs(facts({ overdue: [
      { invoiceNo: 'SI-2609-0071', debtor: 'Wong', outstandingSen: 90_000, dueDate: '2026-09-15' },
      { invoiceNo: 'SI-2608-0011', debtor: 'Tan', outstandingSen: 10_000, dueDate: '2026-08-31' },
    ] }), FINANCE);
    expect(mine[0]).toMatchObject({
      rule: 'overdue', title: '2 customer invoices more than 30 days overdue', amountSen: 100_000,
      detail: 'SI-2608-0011 Tan · SI-2609-0071 Wong', since: '2026-10-01', action: { to: '/scm/accounting?tab=ar' },
    });
  });

  it('someone who does not work Finance sees its jobs waiting on Finance', () => {
    const { mine, others } = raiseJobs(facts({ transfers: [{ amountSen: 1, paidOn: TODAY }] }), { ...FINANCE, finance: false });
    expect(mine).toEqual([]);
    expect(others[0]?.who).toBe('Finance');
  });
});

describe('the page', () => {
  it('the checklist counts what is in and what is open, and last month late after the 15th', () => {
    const accounts = [
      { accountCode: '310-0001', bankCode: 'HLB', accountName: 'HLB', createdOn: '2026-09-01' },
      { accountCode: '310-0002', bankCode: 'MBB', accountName: 'MBB', createdOn: '2026-09-01' },
    ];
    const base = facts({
      acquirers: [{ code: 'MBB', name: 'MBB', hasUniqueRef: true }], keyedCardDays: { MBB: ['2026-11-01'] },
      bankAccounts: accounts, lastStatementTo: { '310-0001': TODAY, '310-0002': '2026-10-01' }, lockedLastMonth: ['310-0001'],
      vouchers: [{ stage: 'check', payee: 'A', amountSen: 1, since: TODAY, by: null }],
    });
    const page = buildFinanceTodo(base, FINANCE);
    expect(page.checklist.month).toBe('2026-11');
    expect(page.checklist.daysLeft).toBe(28);
    expect(Object.fromEntries(page.checklist.items.map((c) => [c.label, `${c.value}|${c.state}`]))).toEqual({
      'Merchant reports in': '1 missing|open',
      'Merchant lines open': '0|ok',
      'Bank statements in': '1 / 2|open',
      'Bank lines open': '0|ok',
      'October locked': '1 / 2|open',
      'Vouchers in progress': '1 to check|open',
    });
    const late = buildFinanceTodo({ ...base, today: '2026-11-20' }, FINANCE);
    expect(late.checklist.items.find((c) => c.key === 'months-locked')?.state).toBe('late');
  });

  it('done today is newest first, and a failed read is carried to the page', () => {
    const page = buildFinanceTodo(facts({
      done: [{ key: 'a', text: 'A', je: null, at: '09:05' }, { key: 'b', text: 'B', je: 'JE-1', at: '11:40' }],
      problems: ['bank lines (timeout)'],
    }), FINANCE);
    expect(page.done.map((d) => d.key)).toEqual(['b', 'a']);
    expect(page.problems).toEqual(['bank lines (timeout)']);
  });
});
