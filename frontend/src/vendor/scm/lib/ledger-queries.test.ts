// The General Ledger's pure helpers (docs/bugs/0924): the query string the
// server is asked with, the money dress, the other-side label, and the CSV
// and the printed table — both exactly the rows the screen shows.
import { describe, expect, test } from 'vitest';
import { counterLabel, fmtLedger, fmtSide, journalLabel, ledgerCsv, ledgerQuery, type LedgerReport } from './ledger-queries';
import { ledgerTable } from './ledger-pdf';

const REPORT: LedgerReport = {
  from: '2026-08-01', to: '2026-08-31', showReversed: true,
  scope: { codes: ['310-0010'], fromCode: null, toCode: null, all: false },
  blocks: [{
    code: '310-0010', name: 'CASH AT BANK - MAYBANK', type: 'ASSET', openingSen: 100_000,
    lines: [
      { lineId: 'l1', date: '2026-08-10', jeNo: '2990-JE-2608-0002', journal: 'BANK', counter: { code: '900-A001', name: 'ADVERTISEMENT', more: 0 }, doc: '2990-HPV-2608-017', doc2: null, description: 'Facebook ads, "August" — LOO WEN WEI', who: 'LOO WEN WEI', debitSen: 0, creditSen: 30_000, balanceSen: 70_000, reversal: '' },
      { lineId: 'l2', date: '2026-08-20', jeNo: '2990-JE-2608-0004', journal: 'BANK', counter: { code: '300-0000', name: 'ACCOUNT RECEIVEABLE', more: 2 }, doc: '2990-SO-2608-004', doc2: null, description: 'keyed twice', who: null, debitSen: 161_000, creditSen: 0, balanceSen: 70_000, reversal: 'reversed' },
    ],
    debitSen: 0, creditSen: 30_000, closingSen: 70_000,
  }],
  totals: { debitSen: 0, creditSen: 30_000 },
};

describe('ledgerQuery', () => {
  test('picked accounts win over a range; the tick rides along only when on', () => {
    expect(ledgerQuery({ from: '2026-08-01', to: '2026-08-31', accounts: ['310-0010', '320-0000'], fromAccount: '300-0000', showReversed: true }))
      .toBe('from=2026-08-01&to=2026-08-31&accounts=310-0010%2C320-0000&showReversed=1');
    expect(ledgerQuery({ from: '2026-08-01', to: '2026-08-31', accounts: [], fromAccount: '300-0000', toAccount: '399-9999' }))
      .toBe('from=2026-08-01&to=2026-08-31&fromAccount=300-0000&toAccount=399-9999');
  });
});

describe('the dress', () => {
  test('brackets a contrary balance, blanks an empty side, names the other side and the journal', () => {
    expect(fmtLedger(123_456)).toBe('1,234.56');
    expect(fmtLedger(-5_000)).toBe('(50.00)');
    expect(fmtSide(0)).toBe('');
    expect(fmtSide(2_500)).toBe('25.00');
    expect(counterLabel({ code: '300-0000', name: 'ACCOUNT RECEIVEABLE', more: 2 })).toBe('300-0000 ACCOUNT RECEIVEABLE +2');
    expect(counterLabel(null)).toBe('');
    expect(journalLabel('PURCHASE')).toBe('Purchase');
  });
});

describe('ledgerCsv — the rows the screen shows', () => {
  test('heading, balance b/f, the lines, the totals, the grand total; a comma or a quote is quoted', () => {
    const rows = ledgerCsv(REPORT).split('\n');
    expect(rows[0]).toBe('Account,Date,Entry,Journal,Other side,Ref. 1,Ref. 2,Description,Debit,Credit,Balance,Reversal');
    expect(rows[1]).toBe('310-0010 CASH AT BANK - MAYBANK,,,,,,,BALANCE B/F,,,"1,000.00",');
    expect(rows[2]).toBe('310-0010,2026/08/10,2990-JE-2608-0002,Bank,900-A001 ADVERTISEMENT,2990-HPV-2608-017,,"Facebook ads, ""August"" — LOO WEN WEI",,300.00,700.00,');
    expect(rows[3]).toBe('310-0010,2026/08/20,2990-JE-2608-0004,Bank,300-0000 ACCOUNT RECEIVEABLE +2,2990-SO-2608-004,,keyed twice,"1,610.00",,700.00,reversed');
    expect(rows[4]).toBe('310-0010,,,,,,,TOTAL,0.00,300.00,700.00,');
    expect(rows[5]).toBe(',,,,,,,GRAND TOTAL,0.00,300.00,,');
    expect(rows).toHaveLength(6);
  });
});

describe('ledgerTable — the printed page', () => {
  test('the same rows, with the reversed line marked in its description', () => {
    const t = ledgerTable(REPORT);
    expect(t.head).toEqual(['Date', 'Entry', 'Journal', 'Other side', 'Ref. 1', 'Ref. 2', 'Description', 'Debit', 'Credit', 'Balance']);
    expect(t.lines.map((l) => l.kind)).toEqual(['account', 'bf', 'line', 'line', 'total', 'grand']);
    expect(t.lines[0]!.cells[0]).toBe('310-0010  CASH AT BANK - MAYBANK');
    expect(t.lines[1]!.cells.slice(6)).toEqual(['BALANCE B/F', '', '', '1,000.00']);
    expect(t.lines[2]!.cells).toEqual(['2026/08/10', '2990-JE-2608-0002', 'Bank', '900-A001 ADVERTISEMENT', '2990-HPV-2608-017', '', 'Facebook ads, "August" — LOO WEN WEI', '', '300.00', '700.00']);
    expect(t.lines[3]!.cells[6]).toBe('keyed twice [reversed]');
    expect(t.lines[4]!.cells.slice(6)).toEqual(['TOTAL', '0.00', '300.00', '700.00']);
    expect(t.lines[5]!.cells.slice(6)).toEqual(['GRAND TOTAL', '0.00', '300.00', '']);
  });
});
