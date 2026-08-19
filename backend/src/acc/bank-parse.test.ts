// What this file pins: the two REAL bank exports in hand are read correctly by
// config alone, with no bank named in the code; a signed amount comes out of
// three different shapes (indicator column, separate debit/credit, plain
// signed) and never loses its direction; and a file the reader cannot make
// sense of is REFUSED with a reason naming the column it wanted and what the
// file has instead (§2.14) — never parsed into zero silent lines.
//
// The Maybank fixtures below are copied from
// `Bank Statement/MBB - ACCOUNTACTIVITYREPORT_564418610346.csv`, pipe for pipe:
// its 22 columns, its 20260801 dates, its 000000000171000 amounts and its CR/DR
// column. If Maybank changes the export, this file is where it shows.

import { describe, it, expect } from 'vitest';
import { parseBankStatement, type BankParseConfig } from './bank-parse';

const L = (...lines: string[]) => lines.join('\n');

/* ── The Maybank current account: pipe, integer sen, CR/DR ──────────────── */

const MBB_HEAD = 'BATCH DATE|ACCOUNT NO.|PROD TYPE|EFFECT DATE|EFFECT TIME|BRANCH|TELLER|CODE|SOURCE CODE|AMOUNT|AMOUNT IND|TRX DESCRIPTION|TRX REFERENCE|STD REF IND|STD REF1|STD REF2|STD REF3|FILLER1|FILLER2|FILLER3|FILLER4|FILLER5';
const mbbRow = (date: string, sen: string, ind: string, desc: string, ref: string) =>
  `${date}|0000564418610346|CA|${date}|103009|2988|CEB4PHON|7610|003|${sen}|${ind}|${desc}|${ref}|||||||||`;

const mbbCfg = (over: Partial<BankParseConfig> = {}): BankParseConfig => ({
  code: 'MBB-CA',
  delimiter: '|',
  amountFormat: 'integer-sen',
  creditIndicator: 'CR',
  columnMap: {
    date: 'EFFECT DATE', description: 'TRX DESCRIPTION', reference: 'TRX REFERENCE',
    amount: 'AMOUNT', indicator: 'AMOUNT IND',
  },
  ...over,
});

describe('the Maybank account activity export', () => {
  it('reads its pipe columns, its packed dates and its zero-padded sen', () => {
    const r = parseBankStatement(mbbCfg(), L(
      MBB_HEAD,
      mbbRow('20260801', '000000000171000', 'CR', 'LAU LEE YEN        *', 'Jaslyn'),
      mbbRow('20260803', '000000000728448', 'CR', 'CR/CARD SALES MN 32410011 DATED 31072026', '00113107'),
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toHaveLength(2);
    /* 000000000171000 is RM 1,710.00 — integer sen. Read as a decimal it would
       be RM 171,000,000, which is the whole reason amountFormat exists. */
    expect(r.lines[0]!.amountSen).toBe(171000);
    expect(r.lines[0]!.bookedOn).toBe('2026-08-01');
    expect(r.lines[0]!.description).toBe('LAU LEE YEN *');
    expect(r.lines[0]!.reference).toBe('Jaslyn');
    expect(r.lines[1]!.amountSen).toBe(728448);
    expect(r.periodFrom).toBe('2026-08-01');
    expect(r.periodTo).toBe('2026-08-03');
  });

  /* The DR/CARD SALES pair the format doc flagged: Maybank's DEBIT card
     settlement credits the GROSS and takes its fee back as a separate charge
     on the same reference. Both legs have to survive with their signs. */
  it('keeps the direction of a DR charge that shares its reference with a credit', () => {
    const r = parseBankStatement(mbbCfg(), L(
      MBB_HEAD,
      mbbRow('20260809', '000000000087500', 'CR', 'DR/CARD SALES M/N 2259020 DATED 08082026', 'D90200808'),
      mbbRow('20260809', '000000000000394', 'DR', 'DR/CARD SALES M/N 2259020 DATED 08082026', 'D90200808'),
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => l.amountSen)).toEqual([87500, -394]);
    expect(r.inSen).toBe(87500);
    expect(r.outSen).toBe(394);
    expect(r.netSen).toBe(87106);
  });

  /* The real file ends with a 32-character checksum on a line of its own. It
     is not a transaction and must not become one — nor may it be silently
     dropped, or a file truncated mid-table would look complete. */
  it('counts a trailer it cannot date instead of failing or posting it', () => {
    const r = parseBankStatement(mbbCfg(), L(
      MBB_HEAD,
      mbbRow('20260815', '000000000200000', 'CR', 'MBB CT- TAN AI KEOW *', 'Tan ai keow'),
      '08B42461D66B43C2B6823BC8953AFAB8',
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toHaveLength(1);
    expect(r.skippedLines).toBe(1);
  });

  it('refuses an amount whose indicator is neither CR nor DR rather than guessing', () => {
    const r = parseBankStatement(mbbCfg(), L(
      MBB_HEAD,
      mbbRow('20260801', '000000000171000', '', 'LAU LEE YEN *', 'Jaslyn'),
    ));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/Line 2/);
    expect(r.reason).toMatch(/2026-08-01/);
  });
});

/* ── A printed statement: comma, decimals, debit and credit apart ───────── */

const HLB_HEAD = 'Date,Description,Reference,Debit,Credit,Balance';

const hlbCfg = (over: Partial<BankParseConfig> = {}): BankParseConfig => ({
  code: 'HLB-CA',
  columnMap: {
    date: 'Date', description: 'Description', reference: 'Reference',
    debit: 'Debit', credit: 'Credit', balance: 'Balance',
  },
  ...over,
});

describe('a statement with debit and credit in separate columns', () => {
  it('turns the pair into one signed amount', () => {
    const r = parseBankStatement(hlbCfg(), L(
      HLB_HEAD,
      '18/06/2026,CA Credit Advice,00005992235 MERCHANT 20260616,,"7,261.65","57,261.65"',
      '19/06/2026,Cheque 100231,CHQ100231,"1,200.00",,"56,061.65"',
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => l.amountSen)).toEqual([726165, -120000]);
    expect(r.lines[0]!.reference).toBe('00005992235 MERCHANT 20260616');
  });

  /* Both ends of the period, and the opening is DERIVED — the file prints the
     balance AFTER each line, so the number a reconciliation starts from is the
     first balance less the first movement. Asking the operator for it instead
     would be asking him to reconcile before he can reconcile. */
  it('reports the closing balance and works the opening back out', () => {
    const r = parseBankStatement(hlbCfg(), L(
      HLB_HEAD,
      '18/06/2026,CA Credit Advice,REF1,,"7,261.65","57,261.65"',
      '19/06/2026,Cheque 100231,CHQ100231,"1,200.00",,"56,061.65"',
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.closingBalanceSen).toBe(5606165);
    expect(r.openingBalanceSen).toBe(5726165 - 726165);
    /* And the two ends agree with the movements between them. */
    expect(r.openingBalanceSen! + r.netSen).toBe(r.closingBalanceSen);
  });

  it('reads one signed amount column when that is all the file has', () => {
    const r = parseBankStatement({
      code: 'X', columnMap: { date: 'Date', description: 'Description', amount: 'Amount' },
    }, L('Date,Description,Amount', '2026-06-18,Credit Advice,7261.65', '2026-06-19,Cheque,-1200.00'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => l.amountSen)).toEqual([726165, -120000]);
  });
});

/* ── Refusals: every one names what it wanted and what it got ────────────── */

describe('a file the reader cannot make sense of', () => {
  it('names both headings it looked for, and what the file actually has', () => {
    const r = parseBankStatement(hlbCfg(), L('Invoice No,Customer,Total', 'INV-1,Ali,100.00'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/"Date"/);
    expect(r.reason).toMatch(/"Description"/);
    expect(r.reason).toMatch(/Invoice No, Customer, Total/);
  });

  it('says so when the amount column named in the config is not in the file', () => {
    const r = parseBankStatement({
      code: 'X', columnMap: { date: 'Date', description: 'Description', amount: 'Nett Amount' },
    }, L('Date,Description,Amount', '2026-06-18,Credit Advice,7261.65'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/Nett Amount/);
    expect(r.reason).toMatch(/Date, Description, Amount/);
  });

  /* The disease this whole guard exists for: a heading row that parses and a
     table under it that does not, reported as a clean empty statement. */
  it('refuses a heading with nothing readable under it', () => {
    const r = parseBankStatement(hlbCfg(), L(HLB_HEAD, 'Opening balance,,,,,"50,000.00"', 'Page 1 of 3,,,,,'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no transactions under it/);
  });

  it('refuses a format it cannot read by name, rather than reading it as text', () => {
    const r = parseBankStatement(hlbCfg({ statement_format: 'PDF' }), L(HLB_HEAD, '18/06/2026,x,y,,1.00,1.00'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/PDF/);
    expect(r.reason).toMatch(/HLB-CA/);
  });
});

/* ── The header is not always line 1 ─────────────────────────────────────── */

describe('a bank that prints something before its table', () => {
  it('finds the heading row under the account header', () => {
    const r = parseBankStatement(hlbCfg(), L(
      'STATEMENT OF ACCOUNT',
      'Account,23600602788,,,,',
      '',
      HLB_HEAD,
      '18/06/2026,CA Credit Advice,REF1,,"7,261.65","57,261.65"',
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.lineNo).toBe(5);
  });

  /* A statement whose dates carry no year is dated by the operator's answer,
     never by a guess (§2.5) — the same rule the acquirer side already obeys. */
  it('dates a year-less statement from the month it is told, and refuses without one', () => {
    const file = L(HLB_HEAD, '18-Jun,CA Credit Advice,REF1,,"7,261.65","57,261.65"');
    const dated = parseBankStatement(hlbCfg({ statementMonth: '2026-06' }), file);
    expect(dated.ok).toBe(true);
    if (dated.ok) expect(dated.lines[0]!.bookedOn).toBe('2026-06-18');

    const undated = parseBankStatement(hlbCfg(), file);
    expect(undated.ok).toBe(false);
  });
});
