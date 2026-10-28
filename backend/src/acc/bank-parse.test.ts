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
import { parseBankStatement, movementFingerprint, type BankParseConfig } from './bank-parse';

const L = (...lines: string[]) => lines.join('\n');

/* ── The Hong Leong exports (owner 2026-09-08) — SYNTHETIC rows in the two real
   layouts of account 23600602788; his files never enter this tree. ───────── */

const hlbCsvCfg = (over: Partial<BankParseConfig> = {}): BankParseConfig => ({
  code: 'HLB 310-0020',
  columnMap: {
    date: ['Date', 'Transaction Date'],
    description: ['Transaction Description', 'Remarks'],
    reference: ['Ref. No.', 'Sender / Receiver Name', 'Receipient Reference', 'Other Payment Details'],
    debit: ['Withdrawal', 'Payment Amount'],
    credit: ['Deposit', 'Credit Amount'],
    balance: ['Balance'],
  },
  ...over,
});

/* The monthly statement: a title row, every cell wrapped as ="…", an opening
   row, the balance printed only on a day's LAST line. */
const HLB_MONTHLY = L(
  'HLB PRIMEBIZ CURRENT ACCOUNT - 23600602788,',
  'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
  '="",="Balance from previous statement",="",="",="",="",="938.37"',
  '="05-05-2026",="CIB Instant Transfer at DIO",="",="Rent ABC PROPERTY SDN BHD 20260505HLBBMYKL010OCB74428488",="",="800.00",=""',
  '="05-05-2026",="Fund Transfer at DIO",="",="Capital HOLDING CO SDN. BHD.",="55000.00",="",="55138.37"',
  '="08-05-2026",="CA Credit Advice",="",="00005992235  MERCHANT 20260507",="1788.28",="",="56926.65"',
);

describe('the Hong Leong monthly statement', () => {
  it('strips the ="…" guard, reads Deposit/Withdrawal as one signed amount, and takes the opening from its own row', () => {
    const r = parseBankStatement(hlbCsvCfg(), HLB_MONTHLY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => [l.bookedOn, l.amountSen])).toEqual([
      ['2026-05-05', -80000], ['2026-05-05', 5500000], ['2026-05-08', 178828],
    ]);
    expect(r.lines[0]!.description).toBe('CIB Instant Transfer at DIO');
    expect(r.lines[0]!.reference).toBe('Rent ABC PROPERTY SDN BHD 20260505HLBBMYKL010OCB74428488');
    /* Read from "Balance from previous statement", not derived from the day's
       one printed balance — that line is the day's LAST, after both movements. */
    expect(r.openingBalanceSen).toBe(93837);
    expect(r.closingBalanceSen).toBe(5692665);
    /* The opening row is counted, not posted. */
    expect(r.skippedLines).toBe(1);
    expect(r.periodFrom).toBe('2026-05-05');
    expect(r.periodTo).toBe('2026-05-08');
  });
});

/* The any-day "Transaction Details" export: an eleven-row preamble carrying the
   opening ("Prior Day Balance"), thousands separators, three narrative columns,
   and the rows NEWEST FIRST. */
const HLB_ANYDAY = L(
  'Transaction Details,,,,,,,,,',
  ',,,,,,,,,,',
  'Report Generated On :,08/09/2026 19:05,,,,,,,,',
  'Account Number / Currency :,23600602788 MYR,,,,,,,,',
  'Account Name :,SOME COMPANY SDN. BHD.,,,,,,,,',
  'Statement Period :,01/08/2026-31/08/2026,,,,,,,,',
  'Branch Name :,"JALIL LINK, BUKIT JALIL",,,,,,,,',
  'Prior Day Balance :,"31,425.26",,,,,,,,',
  ',,,,,,,,,,',
  'Transaction Date,Remarks,Cheque No.,Sender / Receiver Name,Receipient Reference,Other Payment Details,Payment Amount,Credit Amount,Balance,Branch Code',
  '05/08/2026,Fund Transfer,,HOLDING CO SDN. BHD.,Transfer,,0.00,"80,000.00","87,080.37",236',
  '05/08/2026,CIB Instant Transfer,,CAT SUPPLIES SDN BHD,Meta Claim,PV-000088,"7,735.12",0.00,"73,488.25",236',
  '04/08/2026,CA Credit Advice,,,00005992284  MERCHAN,T 20260803,0.00,"1,499.00","37,372.96",236',
  '03/08/2026,Instant Transfer,,RACHEL NG,Fund transfer,,0.00,"1,433.00","32,858.26",236',
);

describe('the Hong Leong any-day export', () => {
  it('finds the heading row under the preamble, joins the three narrative columns, reads thousands separators, and puts the rows in date order', () => {
    const r = parseBankStatement(hlbCsvCfg(), HLB_ANYDAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    /* The file ran newest first, top row latest: reversed whole, so the day's
       rows come out in the order they happened (the top row of a day is its
       LAST movement — its balance is the day's closing). */
    expect(r.lines.map((l) => [l.bookedOn, l.amountSen])).toEqual([
      ['2026-08-03', 143300], ['2026-08-04', 149900], ['2026-08-05', -773512], ['2026-08-05', 8000000],
    ]);
    expect(r.lines[0]!.reference).toBe('RACHEL NG Fund transfer');
    expect(r.lines[2]!.reference).toBe('CAT SUPPLIES SDN BHD Meta Claim PV-000088');
    /* Hong Leong splits "MERCHANT" across two columns; joined with a space it
       arrives as "MERCHAN T", which the recognition rule tolerates. */
    expect(r.lines[1]!.reference).toBe('00005992284 MERCHAN T 20260803');
    expect(r.openingBalanceSen).toBe(3142526);
    /* Closing = the newest row's balance, not the one printed last in the file. */
    expect(r.closingBalanceSen).toBe(8708037);
    expect(r.periodFrom).toBe('2026-08-03');
    expect(r.periodTo).toBe('2026-08-05');
  });

  /* 别卡死读 column, 我怕未来 bank 可能换 format: a config that names only the
     monthly captions still reads the any-day file through the reader's
     built-in headings — and a file with none of them is refused by name. */
  it('a config naming only one layout reads the other through the built-in headings', () => {
    const r = parseBankStatement(hlbCsvCfg({ columnMap: { date: 'Date', description: 'Transaction Description', debit: 'Withdrawal', credit: 'Deposit' } }), HLB_ANYDAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toHaveLength(4);
    expect(r.lines[2]!.amountSen).toBe(-773512);
  });

  it("a file whose headings nobody taught it is refused, quoting the file's own headings", () => {
    const r = parseBankStatement(hlbCsvCfg(), L('Bil,Keterangan,Jumlah', '1,Sewa,800.00'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no heading row with a date column/);
    expect(r.reason).toMatch(/Bil, Keterangan, Jumlah/);
  });
});

describe("a movement's fingerprint — the same transaction however the bank printed it", () => {
  it('ignores word order, case and punctuation, and glues a split word back together', () => {
    const monthly = movementFingerprint({ bookedOn: '2026-08-03', amountSen: 143300, description: 'Fund Trf fr CA to CA-Internet', reference: 'Fund transfer RACHEL NG' });
    const anyDay = movementFingerprint({ bookedOn: '2026-08-03', amountSen: 143300, description: 'Fund Trf fr CA to CA-Internet', reference: 'RACHEL NG Fund transfer' });
    expect(anyDay).toBe(monthly);
    const merchantMonthly = movementFingerprint({ bookedOn: '2026-08-04', amountSen: 149900, description: 'CA Credit Advice', reference: '00005992284  MERCHANT 20260803' });
    const merchantAnyDay = movementFingerprint({ bookedOn: '2026-08-04', amountSen: 149900, description: 'CA Credit Advice', reference: '00005992284 MERCHAN T 20260803' });
    expect(merchantAnyDay).toBe(merchantMonthly);
  });

  it('a different day, amount or counterparty is a different movement', () => {
    const base = { bookedOn: '2026-08-03', amountSen: 143300, description: 'Instant Transfer', reference: 'RACHEL NG' };
    expect(movementFingerprint({ ...base, bookedOn: '2026-08-04' })).not.toBe(movementFingerprint(base));
    expect(movementFingerprint({ ...base, amountSen: 143301 })).not.toBe(movementFingerprint(base));
    expect(movementFingerprint({ ...base, reference: 'RACHEL TAN' })).not.toBe(movementFingerprint(base));
  });
});

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

  /* Since 2026-09-08 (owner: 别卡死读 column) a column the config names wrongly
     is still found under the names banks are known to print — "Amount" here
     — and only a file with NO amount column the reader can name is refused,
     the configured name and the file's own columns both quoted. */
  it('reads an amount column under a built-in name when the config names it wrongly, and says so when no name fits', () => {
    const ok = parseBankStatement({
      code: 'X', columnMap: { date: 'Date', description: 'Description', amount: 'Nett Amount' },
    }, L('Date,Description,Amount', '2026-06-18,Credit Advice,7261.65'));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.lines[0]!.amountSen).toBe(726165);

    const r = parseBankStatement({
      code: 'X', columnMap: { date: 'Date', description: 'Description', amount: 'Nett Amount' },
    }, L('Date,Description,Nett Value', '2026-06-18,Credit Advice,7261.65'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/Nett Amount/);
    expect(r.reason).toMatch(/Date, Description, Nett Value/);
  });

  /* The disease this whole guard exists for: a heading row that parses and a
     table under it that does not, reported as a clean empty statement. A file
     that prints neither a movement nor a balance proves nothing. */
  it('refuses a heading with nothing readable under it', () => {
    const r = parseBankStatement(hlbCfg(), L(HLB_HEAD, 'Some memo,,,,,', 'Page 1 of 3,,,,,'));
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

/* ── A month in which nothing moved ───────────────────────────────────────────
   Owner, 2026-09-10, on Hong Leong's March export — one "Balance from previous
   statement 3000.00" row and nothing under it — being refused: 我应该每一个月
   都要做 bank reconciliation 不是？没有 transaction 那么你就让我锁起来. He is
   right: a month with no movement is still reconciled (bank 3,000 = books
   3,000) and closed. Such a file carries its balance and no dates, so the
   month it speaks for is the one the operator names (docs/bugs/0794). */
describe('a statement with no transactions', () => {
  const EMPTY = L(
    'HLB PRIMEBIZ CURRENT ACCOUNT - 23600600000,',
    'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
    '="",="Balance from previous statement",="",="",="",="",="3000.00"',
  );
  const cfg = (over: Partial<BankParseConfig> = {}) => hlbCfg({
    columnMap: { date: 'Date', description: 'Transaction Description', reference: 'Ref. No.', debit: 'Withdrawal', credit: 'Deposit', balance: 'Balance' },
    ...over,
  });

  it('is filed under the month the operator names, opening and closing at the balance it prints', () => {
    const r = parseBankStatement(cfg({ statementMonth: '2026-03' }), EMPTY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toEqual([]);
    expect(r.periodFrom).toBe('2026-03-01');
    expect(r.periodTo).toBe('2026-03-31');
    expect(r.openingBalanceSen).toBe(300000);
    expect(r.closingBalanceSen).toBe(300000);
    expect(r.inSen).toBe(0);
    expect(r.outSen).toBe(0);
  });

  /* Without a month there is nothing to file it under — and the refusal says
     what to do, not just what went wrong. */
  it('asks for the year and month when none was given', () => {
    const r = parseBankStatement(cfg(), EMPTY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no transactions/);
    expect(r.reason).toMatch(/3,000\.00/);
    expect(r.reason).toMatch(/year and month/i);
  });

  /* A file with no movement AND no balance proves nothing about any month. */
  it('still refuses a file that prints no balance either', () => {
    const r = parseBankStatement(cfg({ statementMonth: '2026-03' }), L(
      'Date,Transaction Description,Cheque No.,Ref. No.,Deposit,Withdrawal,Balance',
      'Page 1 of 1,,,,,,',
    ));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no transactions under it/);
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
