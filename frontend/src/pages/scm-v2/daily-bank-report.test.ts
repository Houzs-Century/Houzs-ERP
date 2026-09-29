/* The Daily Bank table model (owner 2026-09-29) — ONE model read by the page,
   the image and the PDF. Pinned: a section per money account in the board's
   order with its Bank Balance; the rows in the sample's order, a group row
   only when it has lines; the figures in their columns (received, paid, the
   last column for pending, B/F, available and transit); the last section for
   what names no bank, only when there is some; the day's label. */
import { describe, expect, test } from 'vitest';
import type { DailyBankBoard } from './accounting-phase1-queries';
import { boardDayLabel, dailyBankSections, isDetailRow } from './daily-bank-report';

const block = (over: Partial<DailyBankBoard['blocks'][number]>): DailyBankBoard['blocks'][number] => ({
  accountCode: '310-0010', accountName: 'CASH AT BANK - MAYBANK',
  openingSen: 0, inSen: 0, outSen: 0, closingSen: 0, receipts: [], payouts: [],
  pending: [], pendingSen: 0, availableSen: 0, transit: [], transitSen: 0, availableWithTransitSen: 0, ...over,
});
const board = (over: Partial<DailyBankBoard>): DailyBankBoard => ({
  date: '2026-09-29', blocks: [], transit: [], totalClosingSen: 0, totalTransitSen: 0, pendingApprovalSen: 0, availableSen: 0,
  unassignedTransit: [], unassignedPending: [], note: '', ...over,
});

describe('dailyBankSections', () => {
  test('a bank with everything: the sample\'s order, each figure in its column', () => {
    const [s] = dailyBankSections(board({ blocks: [block({
      accountCode: '310-0020', accountName: 'CASH AT BANK - HLBB', openingSen: 1_000, inSen: 500, outSen: 200, closingSen: 1_300,
      receipts: [{ jeNo: 'J1', sourceType: 'SOPAY', sourceDocNo: 'x', docNo: 'OR-1', party: 'Hookka', note: 'Deposit', amountSen: 500 }],
      payouts: [{ jeNo: 'J2', sourceType: 'PV', sourceDocNo: 'PV-1', docNo: 'PV-1', party: null, note: 'Rent', amountSen: 200 }],
      pending: [{ id: 'p', pvNumber: 'HPV-1', payee: 'UNICOM', description: 'Bill', voucherDate: '2026-09-18', accountCode: '310-0020', amountSen: 100 }],
      pendingSen: 100, availableSen: 1_200,
      transit: [{ acquirerCode: 'PBB', accountCode: '326-0010', accountName: 'PBB clearing', balanceSen: 50, bankAccountCode: '310-0020' }],
      transitSen: 50, availableWithTransitSen: 1_250,
    })] }));
    expect(s).toMatchObject({ key: '310-0020', title: 'CASH AT BANK - HLBB', code: '310-0020', bankBalanceSen: 1_300 });
    expect(s!.rows.map((r) => [r.kind, r.who, r.doc, r.receivedSen, r.paidSen, r.lastSen])).toEqual([
      ['bf', 'Balance B/F', '', null, null, 1_000],
      ['receivedHead', 'Received today', '', 500, null, null],
      ['received', 'Hookka', 'OR-1', 500, null, null],
      ['paidHead', 'Paid today', '', null, 200, null],
      ['paid', '', 'PV-1', null, 200, null],                       // nobody named: the line stays, the name blank
      ['pendingHead', 'Pending payment (checked, awaiting approval)', '', null, null, 100],
      ['pending', 'UNICOM', 'HPV-1', null, null, 100],
      ['available', 'Available (after pending)', '', null, null, 1_200],
      ['transitHead', 'In transit (swiped, not yet in this bank)', '', null, null, 50],
      ['transit', 'PBB', '326-0010', null, null, 50],
      ['withTransit', 'Available + in transit', '', null, null, 1_250],
    ]);
    expect(s!.rows.filter((r) => isDetailRow(r.kind)).map((r) => r.kind)).toEqual(['received', 'paid', 'pending', 'transit']);
  });

  test('a quiet bank is B/F and available alone; no last section when everything has a bank', () => {
    const sections = dailyBankSections(board({ blocks: [block({ openingSen: 900, closingSen: 900, availableSen: 900, availableWithTransitSen: 900 })] }));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.rows.map((r) => r.kind)).toEqual(['bf', 'available']);
  });

  test('what names no bank gets the last section — pending first, then the card money', () => {
    const sections = dailyBankSections(board({
      blocks: [block({})],
      unassignedPending: [{ id: 'p', pvNumber: 'HPV-9', payee: 'PETTY', description: 'Float', voucherDate: null, accountCode: '320-0000', amountSen: 70 }],
      unassignedTransit: [{ acquirerCode: '未标银行', accountCode: '326-0000', accountName: 'EDC', balanceSen: 30, bankAccountCode: null }],
    }));
    const last = sections.at(-1)!;
    expect(last).toMatchObject({ key: 'unassigned', title: 'Not tied to a bank', code: null, bankBalanceSen: null });
    expect(last.rows.map((r) => [r.kind, r.who, r.description, r.lastSen])).toEqual([
      ['pendingHead', 'Pending payment (checked, awaiting approval)', '', 70],
      ['pending', 'PETTY', '320-0000 · Float', 70],
      ['transitHead', 'In transit (no bank named for it)', '', 30],
      ['transit', '未标银行', 'EDC', 30],
    ]);
  });
});

describe('boardDayLabel', () => {
  test('the weekday and the house date', () => {
    expect(boardDayLabel('2026-09-29')).toBe('Tue · 2026/09/29');
    expect(boardDayLabel('2026-10-04')).toBe('Sun · 2026/10/04');
  });
});
