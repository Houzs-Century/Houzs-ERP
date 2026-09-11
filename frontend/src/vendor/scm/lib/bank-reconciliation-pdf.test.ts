// What this file pins: the bank reconciliation statement TIES, or it is not
// drawn.
//
// A reconciliation report is a document somebody files and an auditor later
// relies on, so the failure that matters is not an ugly layout — it is a tidy
// walk from the bank's balance to a "balance per the books" that is not the
// balance in the books. That looks filed. These tests pin the three ways the
// report refuses to produce one:
//
//   • the walk arrives somewhere other than the ledger — say so, do not file;
//   • the server already found the figures inconsistent — print no walk at all,
//     because a tidy one would launder the error it caught;
//   • no file printed a closing balance — there is nothing to walk from, and a
//     zero is not the same as an absence.
//
// And the one thing it must always print, reconciled or not: WHY each ignored
// movement was left out, because that sentence is the only record of it.

import { describe, expect, test } from 'vitest';
import {
  reconciliationStatement,
  type ReconReportInput, type ReconInput, type AssemblyInput, type ReconLine,
} from './bank-reconciliation-pdf';

const RECON: ReconInput = {
  periodFrom: '2026-09-01', periodTo: '2026-09-30',
  openingStatementSen: 1000000, openingLedgerSen: 1000000, broughtForwardSen: 0,
  closingStatementSen: 1090000, closingLedgerSen: 1090000, differenceSen: 0,
  bankNotInBooks: { count: 0, sen: 0 },
  booksNotOnBank: { count: 0, sen: 0 },
  outstandingPayments: { count: 0, sen: 0 }, outstandingReceipts: { count: 0, sen: 0 },
  computedClosingSen: 1090000, unexplainedSen: 0, tallies: true,
  consistent: true, inconsistency: null, reconciled: true,
};

const ASSEMBLY: AssemblyInput = {
  month: '2026-09', periodFrom: '2026-09-01', periodTo: '2026-09-30',
  statementOpeningSen: 1000000,
  openingFrom: { fileName: 'd01.csv', on: '2026-09-01' },
  statementClosingSen: 1090000,
  closingFrom: { fileName: 'd30.csv', on: '2026-09-30' },
  gaps: [], complete: true,
};

const line = (over: Partial<ReconLine> = {}): ReconLine => ({
  id: 1, booked_on: '2026-09-04', description: 'FUND TRANSFER RACHEL NG',
  reference: 'R1', amount_sen: 50000, kind: 'OTHER', state: 'POSTED',
  posted_je_no: 'JE-2609-0007', note: null, file_name: 'd04.csv', ...over,
});

const input = (over: Partial<ReconReportInput> = {}): ReconReportInput => ({
  accountCode: '310-0020', month: '2026-09',
  assembly: ASSEMBLY, reconciliation: RECON,
  lines: [line()], unmatchedEntries: [],
  ...over,
});

const stepFor = (r: ReturnType<typeof reconciliationStatement>, label: string) =>
  r.steps.find((s) => s.label.startsWith(label));

/* The owner's form (2026-09-11, docs/bugs/0806): balance per the books,
   plus the payments the bank has not paid, less the receipts it has not
   credited, plus or minus what is on the bank and not in the books, equals
   the balance per the bank statement — and the report says whether it does. */
describe('a month that reconciles', () => {
  test('walks from the books to the bank statement and arrives', () => {
    const r = reconciliationStatement(input());
    expect(stepFor(r, 'Balance per the books')!.sen).toBe(1090000);
    expect(stepFor(r, 'Balance per bank statement')!.sen).toBe(1090000);
    expect(r.warnings).toEqual([]);
    expect(r.filable).toBe(true);
  });

  /* The column has to add up as read, or a person checking it by hand gets a
     different answer from the one printed at the bottom. */
  test('the steps sum to the final figure', () => {
    const r = reconciliationStatement(input());
    const walk = r.steps.filter((s) => s.rule !== 'grand').reduce((t, s) => t + s.sen, 0);
    expect(walk).toBe(stepFor(r, 'Balance per bank statement')!.sen);
  });

  test('names the file behind each end of the walk', () => {
    const r = reconciliationStatement(input());
    expect(r.provenance.join(' ')).toContain('d01.csv');
    expect(r.provenance.join(' ')).toContain('d30.csv');
  });
});

describe('a month with outstanding items', () => {
  /* April on Hong Leong: books −2,163.31, one payment of 3,101.68 the bank
     has not paid, RM 600 on the bank nobody has decided, bank 1,538.37. */
  const APRIL: ReconInput = {
    ...RECON,
    closingStatementSen: 153837, closingLedgerSen: -216331, differenceSen: 370168,
    bankNotInBooks: { count: 1, sen: 60000 },
    booksNotOnBank: { count: 1, sen: -310168 },
    outstandingPayments: { count: 1, sen: -310168 }, outstandingReceipts: { count: 0, sen: 0 },
    computedClosingSen: 153837, unexplainedSen: 0, tallies: true, reconciled: false,
  };

  test('adds the payments the bank has not paid, and what is on the bank and not in the books', () => {
    const r = reconciliationStatement(input({ reconciliation: APRIL }));
    expect(stepFor(r, 'Balance per the books')!.sen).toBe(-216331);
    expect(stepFor(r, 'Add: payments in the books the bank has not paid yet')!.sen).toBe(310168);
    expect(stepFor(r, 'Add: payments in the books the bank has not paid yet')!.count).toBe(1);
    expect(stepFor(r, 'Less: receipts in the books the bank has not credited yet')).toBeUndefined();
    expect(stepFor(r, 'On the bank, not in the books')!.sen).toBe(60000);
    expect(stepFor(r, 'Balance per bank statement')!.sen).toBe(153837);
    const walk = r.steps.filter((s) => s.rule !== 'grand').reduce((t, s) => t + s.sen, 0);
    expect(walk).toBe(153837);
    expect(r.filable).toBe(true);
  });

  test('an unexplained remainder gets its own step, and only when there is one', () => {
    expect(stepFor(reconciliationStatement(input({ reconciliation: APRIL })), 'Unexplained')).toBeUndefined();
    const off = reconciliationStatement(input({
      reconciliation: { ...APRIL, closingStatementSen: 153837 + 777, differenceSen: 370945, unexplainedSen: 777, tallies: false },
    }));
    expect(stepFor(off, 'Unexplained')!.sen).toBe(777);
    expect(stepFor(off, 'Balance per bank statement')!.sen).toBe(153837 + 777);
    expect(off.filable).toBe(false);
    expect(off.warnings.join(' ')).toContain('does not tally');
  });
});

describe('a walk that does not arrive', () => {
  /* THE ONE THAT MATTERS. The four figures are self-consistent, the arithmetic
     is fine, and the ledger says something else — so the report must refuse to
     be filed rather than print a tidy statement. */
  test('says both figures and refuses to be filed', () => {
    const r = reconciliationStatement(input({
      reconciliation: { ...RECON, closingLedgerSen: 1234567 },
    }));
    expect(r.filable).toBe(false);
    expect(r.warnings.join(' ')).toContain('walks to');
    expect(r.warnings.join(' ')).toContain('bank statement says');
  });
});

describe('figures the server would not stand behind', () => {
  test('prints no walk at all', () => {
    const r = reconciliationStatement(input({
      reconciliation: {
        ...RECON, consistent: false,
        inconsistency: 'The difference of 100 sen does not equal what is unmatched on either side.',
      },
    }));
    expect(r.steps).toEqual([]);
    expect(r.filable).toBe(false);
    expect(r.warnings.join(' ')).toContain('does not equal what is unmatched');
  });
});

describe('a month whose files print no closing balance', () => {
  test('says there is nothing to reconcile from rather than starting at zero', () => {
    const r = reconciliationStatement(input({
      assembly: { ...ASSEMBLY, statementClosingSen: null, closingFrom: null, complete: false, gaps: ['None of this month\'s files prints a closing balance.'] },
      reconciliation: { ...RECON, closingStatementSen: null, differenceSen: null, reconciled: false },
    }));
    expect(r.steps).toEqual([]);
    expect(r.filable).toBe(false);
    expect(r.warnings.join(' ')).toContain('no bank figure to reconcile from');
    /* The movements are still listed — the month is not a blank page. */
    expect(r.sections.some((s) => s.body.length > 0)).toBe(true);
  });
});

describe('a month with a day missing', () => {
  test('warns before any figure, and is not filable even though it ties', () => {
    const r = reconciliationStatement(input({
      assembly: {
        ...ASSEMBLY, complete: false,
        gaps: ['d04.csv closes on 2026-09-04 and d08.csv opens on 2026-09-08 at a different figure.'],
      },
    }));
    expect(r.warnings[0]).toContain('not covered end to end');
    expect(r.warnings.join(' ')).toContain('d04.csv');
    /* The arithmetic is fine — that is exactly why the gap has to be said. */
    expect(stepFor(r, 'Balance per the books')!.sen).toBe(1090000);
    expect(r.filable).toBe(false);
  });
});

describe('the sections behind the figures', () => {
  const LINES = [
    line({ id: 1, state: 'OPEN', posted_je_no: null, amount_sen: 60000, description: 'CR/CARD SALES' }),
    line({ id: 2, state: 'IGNORED', posted_je_no: null, amount_sen: -2500, note: 'own transfer, booked from the other side' }),
    line({ id: 3, state: 'POSTED', posted_je_no: 'JE-2609-0007' }),
  ];

  test('lists every unposted movement with the file it came off', () => {
    const r = reconciliationStatement(input({ lines: LINES }));
    const open = r.sections.find((s) => s.title.startsWith('On the bank, not in the books'))!;
    expect(open.body).toHaveLength(1);
    expect(open.body[0]).toContain('d04.csv');
  });

  /* THE AUDIT LINE. An ignored movement leaves the difference for ever and this
     sentence is the whole record of the decision. */
  test('prints why each left-out movement was left out', () => {
    const r = reconciliationStatement(input({ lines: LINES }));
    const left = r.sections.find((s) => s.title.startsWith('Left out'))!;
    expect(left.body[0]).toContain('own transfer, booked from the other side');
  });

  test('names an ignored movement that carries no reason rather than hiding it', () => {
    const r = reconciliationStatement(input({
      lines: [line({ id: 2, state: 'IGNORED', posted_je_no: null, note: null })],
    }));
    const left = r.sections.find((s) => s.title.startsWith('Left out'))!;
    expect(left.body[0]).toContain('no reason given');
  });

  test('an empty section says so instead of showing a bare table', () => {
    const r = reconciliationStatement(input({ lines: [] }));
    for (const s of r.sections) {
      expect(s.body).toEqual([]);
      expect(s.note).toBeTruthy();
    }
  });

  test('a ledger entry the bank never showed is listed with its source', () => {
    const r = reconciliationStatement(input({
      unmatchedEntries: [{
        jeNo: 'JE-2609-0011', entryDate: '2026-09-28', sourceType: 'PV',
        sourceDocNo: 'HPV-2609-006', debitSen: 0, creditSen: 45000,
      }],
    }));
    const books = r.sections.find((s) => s.title.startsWith('Outstanding items'))!;
    expect(books.body[0]).toContain('JE-2609-0011');
    expect(books.body[0]?.[2]).toBe('PV · HPV-2609-006');
    /* Money OUT of the account reads as a bracket, like every other statement. */
    expect(books.body[0]?.[4]).toBe('(MYR 450.00)');
  });

  /* Owner, 2026-09-11: pay to who, and the earlier months' entries carried. */
  test('names who was paid, and lists earlier months\' entries in the same table', () => {
    const r = reconciliationStatement(input({
      unmatchedEntries: [
        { jeNo: 'JE-2609-0011', entryDate: '2026-09-28', sourceType: 'PV', sourceDocNo: 'HPV-2609-006', debitSen: 0, creditSen: 45000, partyName: 'TENAGA NASIONAL BERHAD', carried: false },
        { jeNo: 'JE-2608-0031', entryDate: '2026-08-28', sourceType: 'PV', sourceDocNo: 'HPV-2608-031', debitSen: 0, creditSen: 12000, partyName: 'AIR SELANGOR', carried: true },
      ],
    }));
    const books = r.sections.find((s) => s.title.startsWith('Outstanding items'))!;
    expect(books.head).toEqual(['Entry', 'Date', 'Source', 'Who', 'Amount']);
    /* One table, this month's and the earlier month's alike. */
    expect(books.body).toHaveLength(2);
    expect(books.body.map((b) => b[3])).toEqual(['TENAGA NASIONAL BERHAD', 'AIR SELANGOR']);
    expect(r.sections.find((s) => s.title.startsWith('From earlier months'))).toBeUndefined();
  });
});
