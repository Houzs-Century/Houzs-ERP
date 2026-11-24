/* The Daily Bank table model (owner 2026-09-29) — ONE model read by the page,
   the image and the PDF. Pinned: a section per money account in the board's
   order with its Bank Balance; the rows in the sample's order, a group row
   only when it has lines; the figures in their columns, one kind each (owner
   2026-09-29: RECEIVED · PAYMENT — paid today and pending · BALANCE — B/F,
   available, transit); the last section for
   what names no bank, only when there is some; the day's label. */
import { describe, expect, test, vi } from 'vitest';
import type { DailyBankBoard } from './accounting-phase1-queries';
import { DB_COLORS, boardDayLabel, boardSourceLine, dailyBankSections, drawDailyBankCanvas, isDetailRow } from './daily-bank-report';

const block = (over: Partial<DailyBankBoard['blocks'][number]>): DailyBankBoard['blocks'][number] => ({
  accountCode: '310-0010', accountName: 'CASH AT BANK - MAYBANK', start: null,
  openingSen: 0, inSen: 0, outSen: 0, closingSen: 0, receipts: [], payouts: [],
  pending: [], pendingSen: 0, availableSen: 0, transit: [], transitSen: 0, availableWithTransitSen: 0, ...over,
});
const board = (over: Partial<DailyBankBoard>): DailyBankBoard => ({
  date: '2026-09-29', blocks: [], transit: [], totalClosingSen: 0, totalTransitSen: 0, pendingApprovalSen: 0, availableSen: 0,
  unassignedTransit: [], unassignedPending: [], book: 'ledger', notStarted: [], note: '', ...over,
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
    expect(s!.rows.map((r) => [r.kind, r.who, r.doc, r.receivedSen, r.paymentSen, r.balanceSen])).toEqual([
      ['bf', 'Balance B/F', '', null, null, 1_000],
      ['receivedHead', 'Received today', '', 500, null, null],
      ['received', 'Hookka', 'OR-1', 500, null, null],
      ['paidHead', 'Paid today', '', null, 200, null],
      ['paid', '', 'PV-1', null, 200, null],                       // nobody named: the line stays, the name blank
      ['pendingHead', 'Pending payment (checked, awaiting approval)', '', null, 100, null],   // pending sits in PAYMENT with what was paid
      ['pending', 'UNICOM', 'HPV-1', null, 100, null],
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
      unassignedTransit: [{ acquirerCode: 'Untagged bank', accountCode: '326-0000', accountName: 'EDC', balanceSen: 30, bankAccountCode: null }],
    }));
    const last = sections.at(-1)!;
    expect(last).toMatchObject({ key: 'unassigned', title: 'Not tied to a bank', code: null, bankBalanceSen: null });
    expect(last.rows.map((r) => [r.kind, r.who, r.description, r.paymentSen, r.balanceSen])).toEqual([
      ['pendingHead', 'Pending payment (checked, awaiting approval)', '', 70, null],
      ['pending', 'PETTY', '320-0000 · Float', 70, null],
      ['transitHead', 'In transit (no bank named for it)', '', null, 30],
      ['transit', 'Untagged bank', 'EDC', null, 30],
    ]);
  });
});

describe('boardDayLabel', () => {
  test('the weekday and the house date', () => {
    expect(boardDayLabel('2026-09-29')).toBe('Tue · 2026/09/29');
    expect(boardDayLabel('2026-10-04')).toBe('Sun · 2026/10/04');
  });
});

describe('the cash book in the picture (owner 2026-11-23)', () => {
  test('a typed receipt prints its note, with no one and no document; the footer says which board it is', () => {
    const cash = block({
      start: { date: '2026-09-28', balanceSen: 1_000 }, openingSen: 1_000, inSen: 500, closingSen: 1_500,
      receipts: [{ jeNo: '', sourceType: 'TYPED', sourceDocNo: 'r1', docNo: '', party: null, note: 'Hookka deposit', amountSen: 500, method: null, typedBy: 'Chew' }],
    });
    const [s] = dailyBankSections(board({ book: 'cashbook', blocks: [cash] }));
    expect(s!.rows.filter((r) => r.kind === 'received').map((r) => [r.who, r.doc, r.description, r.receivedSen])).toEqual([['', '', 'Hookka deposit', 500]]);
    expect(boardSourceLine(board({ book: 'cashbook', blocks: [cash] }))).toMatch(/^Cash book: each bank from its starting balance/);
    expect(boardSourceLine(board({ blocks: [block({})] }))).toMatch(/^Live from the ledger/);
  });
});

/* The picture's lines (owner 2026-11-23, on the cash book's exported image: 线条).
   jsdom has no canvas, so a stand-in context records what the drawing does. */
describe('the exported picture', () => {
  type Call = { op: string; args: number[]; fill: unknown };
  const draw = (b: DailyBankBoard): Call[] => {
    const calls: Call[] = [];
    let fill: unknown = null;
    const ctx = {
      font: '', textAlign: '', strokeStyle: '', lineWidth: 1,
      get fillStyle() { return fill; },
      set fillStyle(v: unknown) { fill = v; },
      scale: () => undefined,
      fillText: () => undefined,
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillRect: (...args: number[]) => { calls.push({ op: 'fillRect', args, fill }); },
      strokeRect: (...args: number[]) => { calls.push({ op: 'strokeRect', args, fill }); },
    };
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as unknown as HTMLCanvasElement['getContext']);
    try { drawDailyBankCanvas(b); } finally { spy.mockRestore(); }
    return calls;
  };
  const oneBank = block({ openingSen: 1_000, closingSen: 1_000, availableSen: 1_000 });
  const lines = (calls: Call[]) => calls.filter((c) => c.op === 'fillRect' && c.args[3] === 1);

  test('the cash book: a line you can see under the headings and every row, and a frame round each bank', () => {
    const calls = draw(board({ book: 'cashbook', blocks: [{ ...oneBank, start: { date: '2026-09-28', balanceSen: 1_000 } }] }));
    expect(lines(calls).map((c) => c.fill)).toEqual([DB_COLORS.line, DB_COLORS.line, DB_COLORS.line]);   // headings, B/F, available
    expect(calls.filter((c) => c.op === 'strokeRect')).toHaveLength(1);
  });

  test('the original keeps its faint rules under the rows, and no frame', () => {
    const calls = draw(board({ blocks: [oneBank] }));
    expect(lines(calls).map((c) => c.fill)).toEqual([DB_COLORS.rule, DB_COLORS.rule]);
    expect(calls.filter((c) => c.op === 'strokeRect')).toHaveLength(0);
  });
});
