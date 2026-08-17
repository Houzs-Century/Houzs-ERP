// What this file pins: a statement the system cannot read is REFUSED with a
// reason, never parsed into zero silent rows (§2.14); the acquirer's config —
// not the code — decides which column is which and how the fee is presented;
// and a prorated fee adds up to the total the acquirer actually charged, to
// the sen, because a rounding leftover would sit in 320-0000 forever.

import { describe, it, expect } from 'vitest';
import { parseStatement, splitCsvLine, toSen, toIsoDate, type ParseConfig } from './settlement-parse';

const CSV = (...lines: string[]) => lines.join('\n');

const baseCfg = (over: Partial<ParseConfig> = {}): ParseConfig => ({
  code: 'MBB',
  statement_format: 'CSV',
  fee_method: 'stated',
  column_map: { date: 'Txn Date', ref: 'Approval Code', gross: 'Gross', fee: 'MDR' },
  ...over,
});

describe('the mechanical readers', () => {
  it('splitCsvLine keeps a quoted comma inside its own field', () => {
    expect(splitCsvLine('2026-08-01,"HOUZS SDN BHD, KL",100.00')).toEqual(['2026-08-01', 'HOUZS SDN BHD, KL', '100.00']);
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('toSen reads the shapes statements actually print, and refuses the rest', () => {
    expect(toSen('1,234.56')).toBe(123456);
    expect(toSen('RM 20.00')).toBe(2000);
    expect(toSen('(15.00)')).toBe(-1500);
    expect(toSen('15.00-')).toBe(-1500);
    expect(toSen('-15.00')).toBe(-1500);
    expect(toSen('0.07')).toBe(7);
    expect(toSen('n/a')).toBeNull();
    expect(toSen('')).toBeNull();
  });

  it('toIsoDate reads DD/MM/YYYY and ISO, refuses an impossible date', () => {
    expect(toIsoDate('01/08/2026')).toBe('2026-08-01');
    expect(toIsoDate('2026-08-01')).toBe('2026-08-01');
    expect(toIsoDate('32/08/2026')).toBeNull();
    expect(toIsoDate('August 1')).toBeNull();
  });
});

describe('parseStatement — refusals are loud and name what is wrong', () => {
  it('an acquirer whose 决定4 config is missing cannot accept an upload at all', () => {
    const noFormat = parseStatement(baseCfg({ statement_format: null }), CSV('a,b', '1,2'));
    expect(noFormat).toMatchObject({ ok: false });
    expect((noFormat as { reason: string }).reason).toMatch(/statement format/i);

    const noMap = parseStatement(baseCfg({ column_map: null }), CSV('a,b', '1,2'));
    expect((noMap as { reason: string }).reason).toMatch(/file layout/i);

    const noFee = parseStatement(baseCfg({ fee_method: null }), CSV('a,b', '1,2'));
    expect((noFee as { reason: string }).reason).toMatch(/fee method/i);
  });

  it('a PDF-only acquirer is told to export CSV, not fed to the CSV reader', () => {
    const r = parseStatement(baseCfg({ statement_format: 'PDF' }), CSV('x', 'y'));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/PDF/);
  });

  it('the WRONG FILE is refused by name — never a clean screen with zero rows', () => {
    const r = parseStatement(baseCfg(), CSV('Date,Amount', '2026-08-01,10.00'));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/Txn Date/);
    expect((r as { reason: string }).reason).toMatch(/The file starts: Date, Amount/);
  });

  /* Two failures the owner hit on the demo rig, both invisible to him:
     Excel stamps a BOM on every CSV it saves, which glued itself to the first
     heading; and the refusal that would have explained it was being replaced
     with "some details weren't accepted" by the frontend's shared
     humanApiError, because it contained the word "column". */
  it('a file Excel re-saved (with a BOM) still reads', () => {
    const r = parseStatement(baseCfg(), `﻿${CSV(
      'Txn Date,Approval Code,Gross,MDR',
      '01/08/2026,A1,1000.00,15.00',
    )}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
  });

  it('every refusal survives the frontend error humaniser', () => {
    /* The shared humanApiError drops any message that looks like a database
       internal, or runs past 200 characters. A refusal nobody can read is the
       silence §2.14 exists to prevent, so the wording is part of the contract. */
    const swallowed = /violates|constraint|null value|column|relation|syntax|PGRST|error_code|\b\d{5}\b/i;
    const refusals = [
      parseStatement(baseCfg({ statement_format: null }), 'x'),
      parseStatement(baseCfg({ column_map: null }), 'x'),
      parseStatement(baseCfg({ fee_method: null }), 'x'),
      parseStatement(baseCfg({ statement_format: 'PDF' }), 'x'),
      parseStatement(baseCfg(), CSV('Invoice No,Customer,Total', 'INV-1,Ah Seng,250.00')),
      parseStatement(baseCfg(), CSV('Txn Date,Approval Code,Gross,MDR', 'yesterday,A1,1.00,0.10')),
    ];
    for (const r of refusals) {
      expect(r.ok).toBe(false);
      const { reason } = r as { reason: string };
      expect(reason.length).toBeLessThan(200);
      expect(swallowed.test(reason)).toBe(false);
    }
  });

  it('a header-only file is a failure, not an empty day', () => {
    const r = parseStatement(baseCfg(), CSV('Txn Date,Approval Code,Gross,MDR'));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/empty|No transaction lines/i);
  });

  /* Found on the demo rig with a realistic MBB export: the file ends
     `,,TOTAL,6077.00,91.16` — no date, but a perfectly readable amount. The
     first cut skipped a line only when BOTH failed, so the whole upload was
     refused for a summary row. A dateless row cannot be a transaction; it is
     skipped, and COUNTED, so "some rows were dropped" is never a guess. */
  it('a totals row with a readable amount is skipped and counted, not refused', () => {
    const r = parseStatement(baseCfg(), CSV(
      'Txn Date,Approval Code,Card,Gross,MDR',
      '01/08/2026,A1,VISA ****1234,1000.00,15.00',
      ',,TOTAL,1000.00,15.00',
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.skippedLines).toBe(1);
    expect(r.grossSen).toBe(100000);
  });

  /* This rule CHANGED once real statements arrived. A row whose date column
     holds something that is not a date used to stop the parse — but that is
     exactly what a statement's summary rows look like ("SALES & MANUAL
     POSTINGS, , , , , 3500.00, …"), and one file can carry a dozen of them.
     They are skipped and counted now. The protection that matters survives: a
     file with no readable transaction at all is still REFUSED, never shown as
     an empty batch. */
  it('a file whose rows are all furniture is still refused, not shown empty', () => {
    const r = parseStatement(baseCfg(), CSV(
      'Txn Date,Approval Code,Gross,MDR',
      'yesterday,A1,1000.00,15.00',
    ));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/No transaction lines/i);
  });

  it('an unreadable amount stops the parse and names the line', () => {
    const r = parseStatement(baseCfg(), CSV(
      'Txn Date,Approval Code,Gross,MDR',
      '01/08/2026,A1,100.00,2.00',
      '02/08/2026,A2,oops,2.00',
    ));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/Line 3/);
  });

  it('a net larger than the gross means the file is being read wrong, and says so', () => {
    const r = parseStatement(
      baseCfg({ fee_method: 'gross-minus-net', column_map: { date: 'Txn Date', gross: 'Gross', net: 'Net' } }),
      CSV('Txn Date,Gross,Net', '01/08/2026,100.00,110.00'),
    );
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/larger than the gross/);
  });
});

describe('parseStatement — the three fee methods', () => {
  it('stated: the fee column is the fee, and the totals are the file', () => {
    const r = parseStatement(baseCfg(), CSV(
      'Txn Date,Approval Code,Gross,MDR',
      '01/08/2026,A1,1000.00,15.00',
      '02/08/2026,A2,"2,000.00",30.00',
      ',,,',
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(2);
    expect(r.skippedLines).toBe(1);
    expect(r.rows[0]).toMatchObject({ lineNo: 2, txnDate: '2026-08-01', ref: 'A1', grossSen: 100000, feeSen: 1500, netSen: 98500 });
    expect(r.grossSen).toBe(300000);
    expect(r.feeSen).toBe(4500);
    expect(r.netSen).toBe(295500);
    expect(r.periodFrom).toBe('2026-08-01');
    expect(r.periodTo).toBe('2026-08-02');
  });

  it('gross-minus-net: the fee is what did not arrive', () => {
    const r = parseStatement(
      baseCfg({ fee_method: 'gross-minus-net', column_map: { date: 'Date', gross: 'Gross', net: 'Net Credited' } }),
      CSV('Date,Gross,Net Credited', '01/08/2026,1000.00,985.00'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]).toMatchObject({ grossSen: 100000, feeSen: 1500, netSen: 98500 });
  });

  it('prorated-summary: the spread fees sum EXACTLY to the total charged', () => {
    const cfg = baseCfg({ fee_method: 'prorated-summary', column_map: { date: 'Date', gross: 'Gross' }, summaryFeeSen: 1000 });
    const r = parseStatement(cfg, CSV('Date,Gross', '01/08/2026,33.33', '01/08/2026,33.33', '01/08/2026,33.34'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.reduce((s, x) => s + x.feeSen, 0)).toBe(1000);
    expect(r.feeSen).toBe(1000);
    expect(r.netSen).toBe(r.grossSen - 1000);
  });

  it('prorated-summary without the total is refused, not guessed at zero', () => {
    const cfg = baseCfg({ fee_method: 'prorated-summary', column_map: { date: 'Date', gross: 'Gross' } });
    const r = parseStatement(cfg, CSV('Date,Gross', '01/08/2026,10.00'));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/total/i);
  });
});

/* The shapes of the OWNER'S ACTUAL EXPORTS, read off the files he uploaded on
   2026-08-17. Everything above was written against invented statements, and
   every one of these cases is something a real file does that an invented one
   did not — which is why all three of his uploads were refused. */
describe('parseStatement — the real terminal statements', () => {
  const MAYBANK = [
    'MERCHANT NO:,00000000000,,,TRADING NAME:,DEMO',
    'SUMMARY',
    'TRANSACTION TYPE,,,,,TRXN AMOUNT,MDR/INCENTIVE,LATE FEE,,AMOUNT PAYABLE',
    'SALES & MANUAL POSTINGS,,,,,5700.00,-256.50,0.00,,5443.50',
    ',,,,,,,,TOTAL AMOUNT PAYABLE,5443.50',
    'TERMINAL ID:,00071213960',
    'DATE,BATCH,INVOICE/AUTHO,CARD NUMBER,TENURE/CASHOUT*,TRXN AMOUNT,MDR,LATE FEE,MDR(%),INTERCHANGE FEE,TRXN NET',
    '05-Jun,68035,454919,4293-20xx-xxxx-4789,12,5700.00,256.500000,0.000000,4.50,="0.6%",5443.500000',
    ',,,Batch Total,1,5700.00,256.500000,0.000000,,,5443.500000',
    '*Cash Out Description Code:  CP - Cash Out Purchase Amount  CO - Cash Out Withdrawal Amount',
  ].join('\n');

  const maybankCfg = (over: Partial<ParseConfig> = {}): ParseConfig => ({
    code: 'MBB', statement_format: 'CSV', fee_method: 'stated',
    column_map: { date: 'DATE', ref: 'INVOICE/AUTHO', gross: 'TRXN AMOUNT', fee: 'MDR', net: 'TRXN NET' },
    ...over,
  });

  it('finds the headings on line 7, under the merchant and summary preamble', () => {
    const r = parseStatement(maybankCfg({ statementMonth: '2026-06' }), MAYBANK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ txnDate: '2026-06-05', ref: '454919', grossSen: 570000, feeSen: 25650, netSen: 544350 });
    // Preamble + the batch total + the footnote, all counted, none silent.
    expect(r.skippedLines).toBe(8);
  });

  it('a date with no year in the file is REFUSED until the month is given', () => {
    const r = parseStatement(maybankCfg(), MAYBANK);
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/without a year/);
    expect((r as { reason: string }).reason).toMatch(/05-Jun/);
  });

  /* The real Hong Leong export: TWO merchant blocks in one file, each opening
     with its own SUMMARY whose rows carry prose in the date column and money in
     the money column. Refusing those made every multi-merchant statement
     unreadable — this is the case that proved it. */
  it('reads a file holding several MERCHANT blocks, each with its own summary', () => {
    const twoMerchants = [
      'MERCHANT NO:,00005407101,,,TRADING NAME:,DEMO',
      'SUMMARY',
      'TRANSACTION TYPE,,,,ITEMS,TRXN AMOUNT,MDR,LATE FEE,,TRXN NET',
      'SALES,HLB CARD,VISA CARD,,2,2394.00,21.546000,0.000000,,2372.454000',
      'TERMINAL ID:,00099423076',
      'DATE,BATCH,INVOICE/AUTHO,CARD NUMBER,TENURE/CASHOUT*,TRXN AMOUNT,MDR,LATE FEE,MDR(%),INTERCHANGE FEE,TRXN NET',
      '16-Aug,64265,663554,4902-82xx-xxxx-2474,  ,1800.00,16.200000,0.000000,0.90,="0.6%",1783.800000',
      ',,,Batch Total,1,1800.00,16.200000,0.000000,,,1783.800000',
      'MERCHANT NO:,00005407119,,,TRADING NAME:,DEMO',
      'SUMMARY',
      'SALES & MANUAL POSTINGS,,,,,3500.00,-14.00,0.00,,3486.00',
      'SALES,NON-HLB CARDS,MyDebit,,1,3500.00,14.000000,0.000000,,3486.000000',
      'TERMINAL ID:,00099423082',
      'DATE,BATCH,INVOICE/AUTHO,CARD NUMBER,TENURE/CASHOUT*,TRXN AMOUNT,MDR,LATE FEE,MDR(%),INTERCHANGE FEE,TRXN NET',
      '16-Aug,57578,448433,5509-89xx-xxxx-5679,  ,3500.00,14.000000,0.000000,0.40,="RM0.37+0.001%",3486.000000',
    ].join('\n');
    const r = parseStatement(maybankCfg({ statementMonth: '2026-08' }), twoMerchants);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.ref)).toEqual(['663554', '448433']);
    expect(r.grossSen).toBe(180000 + 350000);
    // Everything that is not a transaction is counted, never silently dropped.
    expect(r.skippedLines).toBeGreaterThan(0);
  });

  it('a dateless year still stops the upload even among all that furniture', () => {
    const r = parseStatement(maybankCfg(), [
      'MERCHANT NO:,00005407101,,,TRADING NAME:,DEMO',
      'SALES & MANUAL POSTINGS,,,,,3500.00,-14.00,0.00,,3486.00',
      'DATE,BATCH,INVOICE/AUTHO,CARD NUMBER,TENURE/CASHOUT*,TRXN AMOUNT,MDR,LATE FEE,MDR(%),INTERCHANGE FEE,TRXN NET',
      '16-Aug,64265,663554,4902-82xx-xxxx-2474,  ,1800.00,16.200000,0.000000,0.90,="0.6%",1783.800000',
    ].join('\n'));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/without a year/);
  });

  it("a second terminal's repeated heading row is a section break, not a transaction", () => {
    const twoTerminals = [
      MAYBANK,
      'TERMINAL ID:,00071213961',
      'DATE,BATCH,INVOICE/AUTHO,CARD NUMBER,TENURE/CASHOUT*,TRXN AMOUNT,MDR,LATE FEE,MDR(%),INTERCHANGE FEE,TRXN NET',
      '06-Jun,68036,454920,5412-30xx-xxxx-9001,,100.00,4.500000,0.000000,4.50,="0.6%",95.500000',
    ].join('\n');
    const r = parseStatement(maybankCfg({ statementMonth: '2026-06' }), twoTerminals);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.ref)).toEqual(['454919', '454920']);
  });

  it("GHL's export reads, apostrophe-guarded ids and all — and it HAS a unique id", () => {
    const r = parseStatement({
      code: 'GHL', statement_format: 'CSV', fee_method: 'stated',
      column_map: { date: 'tx_create_date', ref: 'gateway_tx_id', gross: 'tx_amount', fee: 'merchant_mdr_amount', net: 'net_amount' },
    }, [
      'tx_create_date,gateway_tx_id,mah_ref,product_itemname,tx_code_true,terminal_id,currency_code,currency_tx_amount,tx_amount,merchant_mdr_amount,product_commission_amount,vat_amount,net_amount',
      "2026-06-02 18:38:24.0,'615318040666,'VIPP0000040666000010,VISA - IPP12/VISA-EDC-IPP12,PAYMENT,66043062,MYR,,2865.0000,-114.6000,0.0000,0.0000,2750.4000",
    ].join('\n'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The fee is printed NEGATIVE and the id wears Excel's text-guard quote.
    expect(r.rows[0]).toMatchObject({ txnDate: '2026-06-02', ref: '615318040666', grossSen: 286500, feeSen: 11460, netSen: 275040 });
  });
});

/* The 2990 HOME acquirer — a THIRD layout again, and the one that nearly cost
   real money: its "MDR" column is the RATE (0.85 = 0.85%), not the amount. */
describe('parseStatement — the rate-not-amount trap', () => {
  const STATEMENT = [
    '"Sett_date","Trans_date","Card_no","Card_type","Trans_amt","Sett_amt","MDR","Approval_code"',
    '"17062026","17062026","483551XXXXXX2436","VISA","945.00","936.97","0.85","005628"',
    '"17062026","17062026","468786XXXXXX1367","VISA","3,240.00","3,212.46","0.85","042628"',
  ].join('\n');

  it('reads DDMMYYYY dates and derives the fee from gross minus net', () => {
    const r = parseStatement({
      code: 'PBB', statement_format: 'CSV', fee_method: 'gross-minus-net',
      column_map: { date: 'Trans_date', ref: 'Approval_code', gross: 'Trans_amt', net: 'Sett_amt' },
    }, STATEMENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]).toMatchObject({ txnDate: '2026-06-17', ref: '005628', grossSen: 94500, feeSen: 803, netSen: 93697 });
    expect(r.feeSen).toBe(803 + 2754);
  });

  it('REFUSES the same file configured as a stated fee, because the arithmetic does not agree with the file', () => {
    const r = parseStatement({
      code: 'PBB', statement_format: 'CSV', fee_method: 'stated',
      column_map: { date: 'Trans_date', ref: 'Approval_code', gross: 'Trans_amt', fee: 'MDR', net: 'Sett_amt' },
    }, STATEMENT);
    expect(r).toMatchObject({ ok: false });
    // Names the numbers AND the fix, instead of booking RM 0.85 as the charge.
    expect((r as { reason: string }).reason).toMatch(/944\.15.*936\.97|936\.97/);
    expect((r as { reason: string }).reason).toMatch(/gross minus net/);
  });
});

describe('toIsoDate — the year rule', () => {
  it('takes the year from the statement month, and rolls back for a December line on a January statement', () => {
    expect(toIsoDate('05-Jun', { year: 2026, month: 6 })).toBe('2026-06-05');
    expect(toIsoDate('28-Dec', { year: 2027, month: 1 })).toBe('2026-12-28');
    expect(toIsoDate('05-Jun')).toBeNull();
    expect(toIsoDate('05-Jun-2025')).toBe('2025-06-05');
    expect(toIsoDate('05-06-25')).toBe('2025-06-05');
    // Eight packed digits, both ways round, and a shape that is neither.
    expect(toIsoDate('17062026')).toBe('2026-06-17');
    expect(toIsoDate('20260617')).toBe('2026-06-17');
    expect(toIsoDate('99999999')).toBeNull();
  });
});

describe('parseStatement — a refund line', () => {
  it('a negative gross keeps its sign and its fee stays a deduction', () => {
    const r = parseStatement(baseCfg(), CSV('Txn Date,Approval Code,Gross,MDR', '03/08/2026,R1,(500.00),7.50'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]).toMatchObject({ grossSen: -50000, feeSen: 750, netSen: -49250 });
  });
});
