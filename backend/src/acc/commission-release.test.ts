// The monthly commission release, read off the books and posted (owner
// 2026-11-25). Made-up figures throughout. What is pinned:
//   • a bill's month is read off its own line (OCT'26, AUG26, SEP 1 – SEP 30,
//     2026); the books' opening line is the opening balance; reversal pairs and
//     the release itself are not bills;
//   • a company that has not switched it on books nothing;
//   • one entry per month (COMMREL-{co}-{YYYY-MM}) on the month's last day,
//     Dr the commission expense / Cr the prepayment; a second run with nothing
//     moved writes only its log rows;
//   • a bill booked late lands in the month it pays for; a sales invoice
//     cancelled out of an earlier month re-posts that month — the old entry
//     reversed on its own date, never edited, never doubled;
//   • a replacement the chart refuses leaves the old entry standing.

import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { billMonthOf, billsByMonth, loadPrepaidLines } from './commission-bills';
import { endedOnOf, mytMonths, runCommissionRelease } from './commission-release';
import { commissionReleaseLines } from './rules';

const CO = 1;
/* 2 December 2026, 10:00 MYT: November is the last month the release books. */
const NOW = Date.UTC(2026, 11, 2, 2, 0, 0);

describe('the month a bill pays for', () => {
  test('read off the line the way the bills name it', () => {
    expect(billMonthOf("REVENUE TEAM PAYROLL TO COLLECT BACK - OCT'26 (OCT 1 – OCT 31, 2026)")).toBe('2026-10');
    expect(billMonthOf('REVENUE TEAM PAYROLL TO COLLECT BACK AUG26')).toBe('2026-08');
    expect(billMonthOf('Revenue team payroll — Sep 1 – Sep 30, 2026')).toBe('2026-09');
    expect(billMonthOf('SALARY SEPT2026')).toBe('2026-09');
    expect(billMonthOf('payroll november 2026')).toBe('2026-11');
    expect(billMonthOf('OCT’ 26 payroll')).toBe('2026-10');
  });
  test('a day is not a year, and a word is not a month', () => {
    expect(billMonthOf('PAID ON SEP 30')).toBeNull();
    expect(billMonthOf('MAYBANK TRANSFER 2026')).toBeNull();
    expect(billMonthOf('DECORATION 2026')).toBeNull();
    expect(billMonthOf(null)).toBeNull();
  });
});

const gl = (over: Row): Row => ({
  company_id: CO, account_code: '360-0050', posted: true, reversed: false, reversed_by_je: null,
  debit_sen: 0, credit_sen: 0, source_type: 'API', ...over,
});

describe('what the prepayment holds', () => {
  test('the opening, each bill by its month, a month guessed when the line names none; pairs and the release left out', async () => {
    const sb = fakeSb({
      v_gl_entries: [
        gl({ line_id: 1, je_no: 'JE-1', entry_date: '2026-08-31', source_type: 'OPENING', source_doc_no: 'OPEN', debit_sen: 900_00, notes: 'Opening B/F' }),
        gl({ line_id: 2, je_no: 'JE-2', entry_date: '2026-10-15', source_doc_no: 'API-1', debit_sen: 300_00, notes: "PAYROLL SEP'26" }),
        gl({ line_id: 3, je_no: 'JE-3', entry_date: '2026-10-15', source_doc_no: 'API-0', debit_sen: 999_00, reversed: true, reversed_by_je: 'x', notes: "PAYROLL SEP'26" }),
        gl({ line_id: 4, je_no: 'JE-4', entry_date: '2026-10-15', source_type: 'API_REVERSAL', source_doc_no: 'API-0', credit_sen: 999_00, reversed_by_je: 'y', notes: "Reversal — PAYROLL SEP'26" }),
        gl({ line_id: 5, je_no: 'JE-5', entry_date: '2026-11-03', source_doc_no: 'API-2', debit_sen: 40_00, notes: 'top-up' }),
        gl({ line_id: 6, je_no: 'JE-6', entry_date: '2026-10-31', source_type: 'COMMREL', source_doc_no: 'COMMREL-1-2026-10', credit_sen: 100_00 }),
        gl({ line_id: 7, je_no: 'JE-7', entry_date: '2026-10-31', account_code: '900-C003', debit_sen: 5 }),
        gl({ line_id: 8, je_no: 'JE-8', entry_date: '2026-10-31', company_id: 2, debit_sen: 7, notes: "PAYROLL OCT'26" }),
      ],
    });
    const r = await loadPrepaidLines(sb, CO, '360-0050');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => [l.docNo, l.month, l.amountSen, l.monthGuessed])).toEqual([
      ['OPEN', null, 900_00, false],
      ['API-1', '2026-09', 300_00, false],
      ['API-2', '2026-11', 40_00, true],
    ]);
    expect([...billsByMonth(r.lines).entries()]).toEqual([['2026-09', 300_00], ['2026-11', 40_00]]);
  });
});

describe('the rule', () => {
  test('a pair per moved bill month; a month that gives back books the pair the other way', () => {
    const roles = { COMMISSION_PREPAID: '360-0050', COMMISSION_EXPENSE: '900-C003' };
    const lines = commissionReleaseLines(roles, '2026-10', [{ label: 'Oct 2026 bill', sen: 120_00 }, { label: 'Sep 2026 bill', sen: -20_00 }, { label: 'none', sen: 0 }]);
    expect(lines.map((l) => [l.accountCode, l.debitSen, l.creditSen])).toEqual([
      ['900-C003', 120_00, 0], ['360-0050', 0, 120_00],
      ['360-0050', 20_00, 0], ['900-C003', 0, 20_00],
    ]);
    expect(lines[2]!.notes).toMatch(/given back/);
  });
});

describe('when an ended order ended', () => {
  test('the first row of its last run in that status; a cancel approval counts', () => {
    expect(endedOnOf('CANCELLED', [
      { action: 'UPDATE_STATUS', status_snapshot: 'CONFIRMED', created_at: '2026-10-01T02:00:00Z' },
      { action: 'CANCEL_APPROVE', status_snapshot: 'CONFIRMED', created_at: '2026-10-20T17:30:00Z' },
      { action: 'UPDATE_STATUS', status_snapshot: 'CANCELLED', created_at: '2026-10-21T01:00:00Z' },
    ])).toBe('2026-10-21');
    expect(endedOnOf('CLOSED', [])).toBe('1970-01-01');
  });
  test('the month helpers read MYT', () => {
    expect(mytMonths(NOW)).toEqual({ current: '2026-12', last: '2026-11' });
    expect(mytMonths(Date.UTC(2026, 11, 31, 16, 30))).toEqual({ current: '2027-01', last: '2026-12' });
  });
});

/* ── The books: a company with an opening, an October bill and a September bill booked late ── */

const acct = (code: string, parent: string | null, type: string, active = true): Row => ({
  company_id: CO, account_code: code, account_name: code, account_type: type, parent_code: parent, is_active: active,
});

const so = (doc_no: string, so_date: string, total: number, over: Row = {}): Row => ({
  company_id: CO, doc_no, so_date, status: 'CONFIRMED', total_revenue_sen: total, local_total_sen: total,
  mattress_sofa_sen: total, bedframe_sen: 0, accessories_sen: 0, others_sen: 0, ...over,
});

const world = (over: Record<string, Row[]> = {}) => {
  const t: Record<string, Row[]> = {
  companies: [{ id: CO, code: 'HC' }],
  accounts: [
    acct('360-0000', null, 'ASSET'), acct('360-0050', '360-0000', 'ASSET'),
    acct('900-0000', null, 'EXPENSE'), acct('900-C003', '900-0000', 'EXPENSE'),
  ],
  acc_account_roles: [],
  acc_company_settings: [{ company_id: CO, commission_release_on: true, books_start_date: '2026-09-01' }],
  v_gl_entries: [
    gl({ line_id: 1, je_no: 'JE-0', entry_date: '2026-08-31', source_type: 'OPENING', source_doc_no: 'OPEN', debit_sen: 200_00, notes: 'B/F' }),
    gl({ line_id: 2, je_no: 'JE-1', entry_date: '2026-10-31', source_doc_no: 'API-OCT', debit_sen: 600_00, notes: "REVENUE TEAM PAYROLL - OCT'26" }),
  ],
  event_commission_closes: [{ company_id: CO, month: '2026-10-01', paid: { so_date: { 'SO-10A': 400_00, 'SO-10B': 150_00 }, fair: {} }, carried: { so_date: [{ month: '2026-09', docNo: 'SO-10B', sen: 50_00 }], fair: [] } }],
  mfg_sales_orders: [
    so('SO-07', '2026-07-10', 2_000_00),
    so('SO-10A', '2026-10-02', 4_000_00),
    so('SO-10B', '2026-10-05', 2_000_00),
    so('SO-09', '2026-09-12', 1_000_00),
  ],
  sales_invoices: [
    { id: 1, company_id: CO, so_doc_no: 'SO-07', invoice_date: '2026-09-20', total_sen: 2_000_00, status: 'SENT' },
    { id: 2, company_id: CO, so_doc_no: 'SO-10A', invoice_date: '2026-10-28', total_sen: 4_000_00, status: 'PAID' },
    { id: 3, company_id: CO, so_doc_no: 'SO-10B', invoice_date: '2026-11-04', total_sen: 1_000_00, status: 'SENT' },
    { id: 4, company_id: CO, so_doc_no: 'SO-09', invoice_date: '2026-09-25', total_sen: 1_000_00, status: 'SENT' },
  ],
  acc_deposit_invoices: [],
  acc_credit_notes: [],
  mfg_so_audit_log: [],
  so_total_changes: [],
  journal_entries: [],
  journal_entry_lines: [],
  acc_commission_release_runs: [],
  ...over,
  };
  return { sb: fakeSb(t), t };
};

type T = Record<string, Row[]>;
const entriesOf = (t: T, month: string): Row[] => t.journal_entries!.filter((e) => e.source_doc_no === `COMMREL-${CO}-${month}`);
const linesOf = (t: T, jeId: unknown): Array<[string, number, number]> =>
  t.journal_entry_lines!.filter((l) => l.journal_entry_id === jeId).map((l) => [String(l.account_code), Number(l.debit_sen), Number(l.credit_sen)]);

describe('posting the months', () => {
  test('switched off, nothing is booked', async () => {
    const { sb, t } = world({ acc_company_settings: [{ company_id: CO, commission_release_on: false, books_start_date: '2026-09-01' }] });
    const r = await runCommissionRelease(sb, CO, 'cron', NOW);
    expect(r).toEqual({ ok: true, outcomes: [] });
    expect(t.journal_entries).toEqual([]);
  });

  test('one entry per month on its last day; a second run moves nothing', async () => {
    const { sb, t } = world();
    const r1 = await runCommissionRelease(sb, CO, 'cron', NOW);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.outcomes.map((o) => [o.month, o.action, o.releasedSen])).toEqual([
      ['2026-09', 'posted', 200_00],   // the opening, carried by SO-07, invoiced in September
      ['2026-10', 'posted', 400_00],   // SO-10A whole
      ['2026-11', 'posted', 100_00],   // SO-10B half (200 x 1,000 / 2,000)
    ]);
    const oct = entriesOf(t, '2026-10');
    expect(oct).toHaveLength(1);
    expect(oct[0]!.entry_date).toBe('2026-10-31');
    expect(oct[0]!.source_type).toBe('COMMREL');
    expect(linesOf(t, oct[0]!.id)).toEqual([['900-C003', 400_00, 0], ['360-0050', 0, 400_00]]);

    const r2 = await runCommissionRelease(sb, CO, 'cron', NOW);
    expect(r2.ok && r2.outcomes.map((o) => o.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(t.journal_entries).toHaveLength(3);
    expect(t.acc_commission_release_runs).toHaveLength(6);
  });

  test('a September bill booked late releases into September; an invoice cancelled out of October re-posts October', async () => {
    const { sb, t } = world();
    await runCommissionRelease(sb, CO, 'cron', NOW);
    t.v_gl_entries!.push(gl({ line_id: 3, je_no: 'JE-2', entry_date: '2026-11-20', source_doc_no: 'API-SEP', debit_sen: 80_00, notes: "REVENUE TEAM PAYROLL - SEP'26" }));
    t.sales_invoices!.find((x) => x.id === 2)!.status = 'CANCELLED';

    const r = await runCommissionRelease(sb, CO, 'manual', NOW);
    expect(r.ok && r.outcomes.map((o) => [o.month, o.action, o.releasedSen])).toEqual([
      /* September's bill has no close: split by the goods of September's orders — SO-09, invoiced in September. */
      ['2026-09', 'reposted', 280_00],
      ['2026-10', 'cleared', 0],
      ['2026-11', 'unchanged', 100_00],
    ]);
    const sep = entriesOf(t, '2026-09');
    expect(sep.map((e) => e.entry_date)).toEqual(['2026-09-30', '2026-09-30', '2026-09-30']);
    expect(sep.filter((e) => e.reversed !== true && !e.reversed_by_je)).toHaveLength(1);
    /* October: the entry and its contra, both on 31 October, nothing active left. */
    const oct = entriesOf(t, '2026-10');
    expect(oct.map((e) => e.entry_date)).toEqual(['2026-10-31', '2026-10-31']);
    expect(oct.filter((e) => e.reversed !== true && !e.reversed_by_je)).toHaveLength(0);
  });

  test('a replacement the chart refuses leaves the old entry standing', async () => {
    const { sb, t } = world();
    await runCommissionRelease(sb, CO, 'cron', NOW);
    t.accounts!.find((a) => a.account_code === '900-C003')!.is_active = false;
    t.sales_invoices!.find((x) => x.id === 3)!.total_sen = 2_000_00;
    const r = await runCommissionRelease(sb, CO, 'cron', NOW);
    const nov = r.ok ? r.outcomes.find((o) => o.month === '2026-11')! : null;
    expect(nov?.action).toBe('failed');
    expect(nov?.note).toMatch(/nothing was reversed/);
    expect(entriesOf(t, '2026-11').filter((e) => e.reversed !== true)).toHaveLength(1);
  });
});
