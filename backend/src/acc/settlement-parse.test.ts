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
    expect((noMap as { reason: string }).reason).toMatch(/column mapping/i);

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
    expect((r as { reason: string }).reason).toMatch(/Found: Date, Amount/);
  });

  it('a header-only file is a failure, not an empty day', () => {
    const r = parseStatement(baseCfg(), CSV('Txn Date,Approval Code,Gross,MDR'));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toMatch(/empty|No transaction lines/i);
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

describe('parseStatement — a refund line', () => {
  it('a negative gross keeps its sign and its fee stays a deduction', () => {
    const r = parseStatement(baseCfg(), CSV('Txn Date,Approval Code,Gross,MDR', '03/08/2026,R1,(500.00),7.50'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]).toMatchObject({ grossSen: -50000, feeSen: 750, netSen: -49250 });
  });
});
