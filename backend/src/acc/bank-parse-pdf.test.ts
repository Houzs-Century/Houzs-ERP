// What this file pins: a Maybank monthly statement PDF, as pdf.js hands it
// over (text with x/y, grouped into lines), reads into the same shape the CSV
// reader produces — every row with its day, its signed amount and its running
// balance, the beginning and ending balances — and refuses rather than
// guesses when the rows do not walk from the one balance to the other.
//
// The fixture mimics the real layout (docs/bugs/0869): the statement date
// dd/mm/yy in the header, rows dd/mm at the left edge, the amount with a +/-
// suffix, the balance at the right, continuation lines with no figure, the
// page header repeating, rows spilling onto a second page, ENDING BALANCE
// ending them. The figures are made up.

import { describe, it, expect } from 'vitest';
import { parsePdfStatement, readPdfContent, pdfDigits, PDF_TEXT_KIND, type PdfPage, type PdfStatement } from './bank-parse-pdf';

const line = (y: number, ...cells: Array<[number, string]>) => ({ y, cells: cells.map(([x, t]) => ({ x, t })) });

const HEADER = (page: number) => [
  line(756, [214, 'Maybank Islamic Berhad (787435-M)']),
  line(718, [312, 'MUKA/'], [340, '/PAGE'], [365, ':'], [480, String(page)]),
  line(704, [312, 'TARIKH PENYATA']),
  line(693, [320, '結單日期'], [365, ':'], [449, '31/08/26']),
  line(689, [85, '2990 HOME SDN. BHD.']),
  line(659, [365, ':'], [426, '564418759397']),
  line(628, [25, 'PROTECTED BY PIDM UP TO RM250,000 FOR EACH DEPOSITOR'], [400, 'SME FIRST ACCOUNT -I']),
  line(592, [28, 'TARIKH MASUK'], [79, 'TARIKH NILAI'], [197, 'BUTIR URUSNIAGA'], [335, 'JUMLAH URUSNIAGA'], [426, 'BAKI PENYATA']),
  line(572, [30, 'ENTRY DATE'], [79, 'VALUE DATE'], [185, 'TRANSACTION DESCRIPTION'], [331, 'TRANSACTION AMOUNT'], [417, 'STATEMENT BALANCE']),
];
const FOOTER = [
  line(104, [31, 'LEDGER BALANCE'], [151, '='], [163, 'ENDING BALANCE - UNCLEARED CHEQUES']),
  line(90, [31, '(1)'], [53, 'Semua maklumat dan baki yang dinyatakan di sini akan dianggap betul']),
];

const PAGE1: PdfPage = { lines: [
  ...HEADER(1),
  line(560, [126, 'BEGINNING BALANCE'], [440, '1,000.00']),
  line(548, [43, '03/08'], [126, 'CR/CARD SALES MN 32649964 D'], [358, '500.00+'], [440, '1,500.00']),
  line(536, [43, '05/08'], [126, 'TRANSFER FR A/C'], [361, '200.00-'], [440, '1,300.00']),
  line(524, [134, 'ENG SUI HOR'], [203, '*']),
  line(512, [134, 'Transfer']),
  line(500, [134, 'MBB CT']),
  line(488, [43, '25/08'], [126, '9202896726 CR/CARD SALES'], [235, 'D'], [358, '1,234.56+'], [440, '2,534.56']),
  ...FOOTER,
] };
const PAGE2: PdfPage = { lines: [
  ...HEADER(2),
  line(548, [43, '26/08'], [126, 'DR/CARD SALES M/N 2649949 D 8'], [377, '6.59-'], [435, '2,527.97']),
  line(296, [126, 'ENDING BALANCE :'], [435, '2,527.97']),
  line(284, [126, 'LEDGER BALANCE :'], [435, '2,527.97']),
  line(248, [126, 'TOTAL DEBIT :'], [440, '206.59']),
  line(236, [126, 'TOTAL CREDIT :'], [435, '1,734.56']),
  ...FOOTER,
] };
const PAGE3: PdfPage = { lines: [...HEADER(3), line(524, [63, 'PLEASE BE REMINDED TO CHECK YOUR BANK ACCOUNT BALANCES REGULARLY']), ...FOOTER] };

const pdf = (pages: PdfPage[]): PdfStatement => ({ kind: PDF_TEXT_KIND, pages });
/** A page with the statement date taken off its header. */
const undated = (page: PdfPage): PdfPage => ({ lines: page.lines.filter((l) => !l.cells.some((c) => c.t === '31/08/26')) });

describe('a Maybank statement PDF', () => {
  it('reads every row with its day (the year off the statement date), its signed amount and its balance, across pages, up to ENDING BALANCE', () => {
    const r = parsePdfStatement({ bankCode: 'MBB', pdf: pdf([PAGE1, PAGE2, PAGE3]), statementMonth: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => [l.lineNo, l.bookedOn, l.description, l.amountSen, l.balanceSen, l.reference])).toEqual([
      [1, '2026-08-03', 'CR/CARD SALES MN 32649964 D', 50000, 150000, null],
      /* The three continuation lines belong to the transfer above them; the lone * is not a word. */
      [2, '2026-08-05', 'TRANSFER FR A/C ENG SUI HOR Transfer MBB CT', -20000, 130000, null],
      [3, '2026-08-25', '9202896726 CR/CARD SALES D', 123456, 253456, null],
      [4, '2026-08-26', 'DR/CARD SALES M/N 2649949 D 8', -659, 252797, null],
    ]);
    expect(r.openingBalanceSen).toBe(100000);
    expect(r.closingBalanceSen).toBe(252797);
    expect(r.periodFrom).toBe('2026-08-03');
    expect(r.periodTo).toBe('2026-08-26');
    expect(r.inSen).toBe(173456);
    expect(r.outSen).toBe(20659);
    expect(r.netSen).toBe(152797);
    expect(r.skippedLines).toBe(0);
  });

  /* THE ONE THAT MATTERS: the rows must walk from the beginning balance to
     the ending balance. A misread row is refused, never loaded. */
  it('refuses a file whose rows do not walk from the beginning balance to the ending balance', () => {
    const broken: PdfPage = { lines: PAGE2.lines.map((l) => (l.cells.some((c) => c.t === 'ENDING BALANCE :') ? line(l.y, [126, 'ENDING BALANCE :'], [435, '2,600.00']) : l)) };
    const r = parsePdfStatement({ bankCode: 'MBB', pdf: pdf([PAGE1, broken]), statementMonth: null });
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toContain('RM 1,000.00');
    expect(r.reason).toContain('RM 2,600.00');
    expect(r.reason).toContain('RM 2,527.97');
  });

  it('takes the year and month off the operator when the header prints no statement date, and refuses when neither is there', () => {
    /* Every page repeats the header, so every page loses the date. */
    const withMonth = parsePdfStatement({ bankCode: 'MBB', pdf: pdf([undated(PAGE1), undated(PAGE2)]), statementMonth: '2026-08' });
    expect(withMonth.ok).toBe(true);
    if (withMonth.ok) expect(withMonth.lines[0]!.bookedOn).toBe('2026-08-03');
    const none = parsePdfStatement({ bankCode: 'MBB', pdf: pdf([undated(PAGE1), undated(PAGE2)]), statementMonth: null });
    expect(none).toMatchObject({ ok: false });
    if (!none.ok) expect(none.reason).toMatch(/year and month/);
  });

  it('a quiet month — balances and no row — stands for the whole month it is dated in', () => {
    const quiet: PdfPage = { lines: [
      ...HEADER(1),
      line(560, [126, 'BEGINNING BALANCE'], [440, '1,000.00']),
      line(548, [126, 'ENDING BALANCE :'], [435, '1,000.00']),
      ...FOOTER,
    ] };
    const r = parsePdfStatement({ bankCode: 'MBB', pdf: pdf([quiet]), statementMonth: null });
    expect(r).toMatchObject({ ok: true, lines: [], periodFrom: '2026-08-01', periodTo: '2026-08-31', openingBalanceSen: 100000, closingBalanceSen: 100000 });
  });

  it('a statement dated January puts a December row in the year before', () => {
    const jan: PdfPage = { lines: [
      ...HEADER(1).map((l) => ({ ...l, cells: l.cells.map((c) => (c.t === '31/08/26' ? { ...c, t: '31/01/27' } : c)) })),
      line(560, [126, 'BEGINNING BALANCE'], [440, '1,000.00']),
      line(548, [43, '31/12'], [126, 'CR/CARD SALES MN 32649964 D'], [358, '10.00+'], [440, '1,010.00']),
      line(536, [43, '02/01'], [126, 'CR/CARD SALES MN 32649964 D'], [358, '10.00+'], [440, '1,020.00']),
      line(296, [126, 'ENDING BALANCE :'], [435, '1,020.00']),
    ] };
    const r = parsePdfStatement({ bankCode: 'MBB', pdf: pdf([jan]), statementMonth: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines.map((l) => l.bookedOn)).toEqual(['2026-12-31', '2027-01-02']);
  });

  it('refuses a bank with no PDF layout by name, and a page with nothing of a statement on it', () => {
    const hlb = parsePdfStatement({ bankCode: 'HLB', pdf: pdf([PAGE1]), statementMonth: null });
    expect(hlb).toMatchObject({ ok: false });
    if (!hlb.ok) expect(hlb.reason).toMatch(/HLB/);
    const blank = parsePdfStatement({ bankCode: 'MBB', pdf: pdf([{ lines: [...HEADER(1).slice(0, 3), ...FOOTER] }]), statementMonth: '2026-08' });
    expect(blank).toMatchObject({ ok: false });
    if (!blank.ok) expect(blank.reason).toMatch(/No transaction rows/);
  });
});

describe('what the browser sends', () => {
  it('is read back shape-checked, lines top first and cells left first; anything else is not a PDF extraction', () => {
    const content = JSON.stringify({ kind: PDF_TEXT_KIND, pages: [{ lines: [
      { y: 100, cells: [{ x: 300, t: 'b' }, { x: 10, t: 'a' }] },
      { y: 200, cells: [{ x: 50, t: '564418759397' }] },
    ] }] });
    const got = readPdfContent(content)!;
    expect(got.pages[0]!.lines.map((l) => [l.y, l.cells.map((c) => c.t)])).toEqual([[200, ['564418759397']], [100, ['a', 'b']]]);
    expect(pdfDigits(got)).toBe('564418759397');
    expect(readPdfContent('EFFECT DATE|AMOUNT\n20260605|100')).toBeNull();
    expect(readPdfContent(JSON.stringify({ kind: 'something-else', pages: [] }))).toBeNull();
    expect(readPdfContent(JSON.stringify({ kind: PDF_TEXT_KIND, pages: [{ lines: [{ y: 'top', cells: [] }] }] }))).toBeNull();
  });
});
