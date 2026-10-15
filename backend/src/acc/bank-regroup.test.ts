/* A statement uploaded before 2026-10-15 holds Maybank's gross-and-fee pair as
   two rows (owner: 这一笔RM4048.00是要扣RM18.22的). bank-regroup writes them
   into the shape the upload now writes: one credit row with the net and the
   charge, decided against today's reports; no fee row. Pinned here:
     • the plan finds exactly 2990's pair and decides it PAYOUT for report 96;
     • the write joins it, removes the fee row and keeps the statement's count;
     • rows somebody decided, rows already joined and repeats are left alone;
     • a closed month refuses before anything moves. */

import { describe, expect, it } from 'vitest';
import { fakeSb, type Row } from '../scm/lib/fake-postgrest';
import { planRegroup, applyRegroup, type StoredLine } from './bank-regroup';
import type { BankRecognitionRule, PayableBatch } from './bank-match';

const CO = 2;
const RULES: BankRecognitionRule[] = [
  { acquirerCode: 'MBB', pattern: 'CARD SALES', tradingDatePattern: 'DATED\\s*(\\d{8})', merchantPattern: 'M/?N\\s*(\\d+)' },
];
const REPORT: PayableBatch = {
  id: 96, acquirerCode: 'MBB', fileName: '027032649949_DVS04E_1_20260906.CSV',
  periodFrom: '2026-09-06', periodTo: '2026-09-06', payableSen: 402978, outstandingSen: 402978,
};
const row = (id: number, lineNo: number, over: Partial<StoredLine> & Row = {}): Row => ({
  id, statement_id: 15, company_id: CO, line_no: lineNo, booked_on: '2026-09-07',
  description: 'DR/CARD SALES M/N 2649949 D 9', reference: null, amount_sen: 0, charge_sen: 0,
  state: 'OPEN', kind: 'OTHER', note: null, acquirer_code: null, trading_date: null, merchant_no: null,
  matched_batch_id: null, split: null, posted_je_no: null, ...over,
});
/* Production's statement 15 on 2026-10-15, cut down to the pair and its neighbours. */
const ROWS = (): Row[] => [
  row(365, 10, { amount_sen: -500000, description: 'CIB Instant Transfer', reference: null }),
  row(366, 11, { amount_sen: 404800, kind: 'PAYOUT_UNSURE', acquirer_code: 'MBB', merchant_no: '2649949', note: 'MBB paid RM 4,048.00, and no single report of theirs is owed that.' }),
  row(367, 12, { amount_sen: 120000, description: 'CR/CARD SALES MN 2649964 DATED 06092026', reference: null }),
  row(368, 13, { amount_sen: -1822 }),
];
const harness = (lines: Row[], locks: Row[] = []) => fakeSb({
  acc_bank_statements: [{ id: 15, company_id: CO, account_code: '310-0010', file_name: 'MBBcurrent_564418759397_2026-09-30.pdf', line_count: 4 }],
  acc_bank_statement_lines: lines,
  acc_bank_month_locks: locks,
});

describe('planRegroup — what the upload would now join', () => {
  it("finds 2990's pair and decides it for the report it pays", () => {
    const pairs = planRegroup(ROWS() as never, RULES, [REPORT], []);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ creditId: 366, feeIds: [368], lineNo: 11, grossSen: 404800, chargeSen: 1822, netSen: 402978 });
    expect(pairs[0]!.decision).toMatchObject({ kind: 'PAYOUT', matched_batch_id: 96, acquirer_code: 'MBB', merchant_no: '2649949' });
  });

  it('reads the day whether it comes back as text or as a Date (the repair script reads through postgres.js)', () => {
    const asDates = ROWS().map((r) => ({ ...r, booked_on: new Date('2026-09-07T00:00:00Z') }));
    const pairs = planRegroup(asDates as never, RULES, [REPORT], []);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.bookedOn).toBe('2026-09-07');
  });

  it('leaves a decided row, an already-joined row and a repeat alone', () => {
    const posted = ROWS().map((r) => (r.id === 368 ? { ...r, state: 'IGNORED' } : r));
    expect(planRegroup(posted as never, RULES, [REPORT], [])).toEqual([]);
    const joined = ROWS().map((r) => (r.id === 366 ? { ...r, amount_sen: 402978, charge_sen: 1822 } : r)).filter((r) => r.id !== 368);
    expect(planRegroup(joined as never, RULES, [REPORT], [])).toEqual([]);
    const repeat = ROWS().map((r) => (r.id === 366 ? { ...r, kind: 'DUPLICATE' } : r));
    expect(planRegroup(repeat as never, RULES, [REPORT], [])).toEqual([]);
  });
});

describe('applyRegroup — writing the join', () => {
  it('the credit takes the net, the charge and the decision; the fee row goes; the count follows', async () => {
    const sb = harness(ROWS());
    const pairs = planRegroup(ROWS() as never, RULES, [REPORT], []);
    const res = await applyRegroup(sb, CO, { id: 15, account_code: '310-0010', line_count: 4 }, pairs);
    expect(res).toMatchObject({ ok: true });
    const lines = sb.tables.acc_bank_statement_lines as Row[];
    expect(lines.map((l) => l.id)).toEqual([365, 366, 367]);
    expect(lines.find((l) => l.id === 366)).toMatchObject({
      amount_sen: 402978, charge_sen: 1822, state: 'OPEN', kind: 'PAYOUT', matched_batch_id: 96,
    });
    expect(String(lines.find((l) => l.id === 366)!.note)).toContain('027032649949_DVS04E_1_20260906.CSV');
    expect((sb.tables.acc_bank_statements as Row[])[0]!.line_count).toBe(3);
  });

  it('a closed month refuses, and nothing moves', async () => {
    const sb = harness(ROWS(), [{
      id: 1, company_id: CO, account_code: '310-0010', period_month: '2026-09-01', locked_by: 'Finance',
      locked_at: '2026-10-15T09:00:00Z', lock_note: null, closing_statement_sen: null, closing_ledger_sen: null,
      difference_sen: null, statement_count: 1, was_complete: true, released_at: null,
    }]);
    const pairs = planRegroup(ROWS() as never, RULES, [REPORT], []);
    const res = await applyRegroup(sb, CO, { id: 15, account_code: '310-0010', line_count: 4 }, pairs);
    expect(res.ok).toBe(false);
    expect((sb.tables.acc_bank_statement_lines as Row[]).map((l) => [l.id, l.amount_sen])).toEqual([
      [365, -500000], [366, 404800], [367, 120000], [368, -1822],
    ]);
  });

  it('a credit somebody already changed is not joined, and its fee row stays', async () => {
    const sb = harness(ROWS().map((r) => (r.id === 366 ? { ...r, state: 'POSTED' } : r)));
    const pairs = planRegroup(ROWS() as never, RULES, [REPORT], []);
    const res = await applyRegroup(sb, CO, { id: 15, account_code: '310-0010', line_count: 4 }, pairs);
    expect(res.ok).toBe(false);
    expect((sb.tables.acc_bank_statement_lines as Row[]).find((l) => l.id === 368)).toBeTruthy();
  });
});
