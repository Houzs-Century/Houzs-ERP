// The books' opening (owner 2026-10-28, Opening Balance page): the account
// lines a save may book, the journal that books them with the stock and the
// clearing's balancing line, and an opening paper's two lines — the import's
// own shape, so a paper changed on the page reads exactly like one imported.

import { describe, expect, it } from 'vitest';
import { OPENING_CLEARING, checkAccountLines, checkStock, openingJournalLines, openingPaperLines } from './opening-balance';

const KNOWN = new Set(['100-0000', '150-0000', '310-0010', '440-0000', '190-0000', '400-0000', '600-0001']);
const REFUSED = new Map([
  ['400-0000', 'is a control account — its opening is the creditors / other debtors papers.'],
  ['600-0001', 'is a stock account — the opening stock is set on the Stock tab.'],
  ['190-0000', "is the opening's own clearing account — it balances itself."],
]);
const STOCK_CODES = { customer: '600-0001', display: '600-0002', service: '600-0003', showroom: '600-0004', others: '600-0005' };

describe('checkAccountLines — what a save may book', () => {
  it('passes whole-sen lines, one per account, each a debit or a credit', () => {
    expect(checkAccountLines([{ code: '310-0010', drSen: 100, crSen: 0 }, { code: '150-0000', drSen: 0, crSen: 100 }], KNOWN, REFUSED)).toBeNull();
  });
  it('refuses, by name: a control, a stock account, the clearing, an unknown code, both sides, nothing, twice, part sen', () => {
    expect(checkAccountLines([{ code: '400-0000', drSen: 0, crSen: 5 }], KNOWN, REFUSED)).toContain('control account');
    expect(checkAccountLines([{ code: '600-0001', drSen: 5, crSen: 0 }], KNOWN, REFUSED)).toContain('Stock tab');
    expect(checkAccountLines([{ code: '190-0000', drSen: 5, crSen: 0 }], KNOWN, REFUSED)).toContain('balances itself');
    expect(checkAccountLines([{ code: '999-9999', drSen: 5, crSen: 0 }], KNOWN, REFUSED)).toContain('not on the chart');
    expect(checkAccountLines([{ code: '310-0010', drSen: 5, crSen: 5 }], KNOWN, REFUSED)).toContain('not both');
    expect(checkAccountLines([{ code: '310-0010', drSen: 0, crSen: 0 }], KNOWN, REFUSED)).toContain('no amount');
    expect(checkAccountLines([{ code: '310-0010', drSen: 5, crSen: 0 }, { code: '310-0010', drSen: 1, crSen: 0 }], KNOWN, REFUSED)).toContain('twice');
    expect(checkAccountLines([{ code: '310-0010', drSen: 5.5, crSen: 0 }], KNOWN, REFUSED)).toContain('whole sen');
    expect(checkAccountLines([{ code: '', drSen: 5, crSen: 0 }], KNOWN, REFUSED)).toContain('Line 1');
  });
});

describe('openingJournalLines — the accounts, the stock, and the clearing that balances them', () => {
  it('books the stock on each bucket\'s STOCKS AT THE BEGINNING and balances on the clearing', () => {
    const lines = openingJournalLines(
      [{ code: '310-0010', drSen: 50_000, crSen: 0 }, { code: '150-0000', drSen: 0, crSen: 20_000 }],
      { customer: 8_000, display: 0, service: 0, showroom: 2_000, others: 0 }, STOCK_CODES,
    );
    expect(lines.map((l) => [l.accountCode, l.debitSen, l.creditSen])).toEqual([
      ['310-0010', 50_000, 0], ['150-0000', 0, 20_000], ['600-0001', 8_000, 0], ['600-0004', 2_000, 0], [OPENING_CLEARING, 0, 40_000],
    ]);
    expect(lines.reduce((s, l) => s + l.debitSen - l.creditSen, 0)).toBe(0);
  });
  it('a journal that balances by itself carries no clearing line', () => {
    const lines = openingJournalLines([{ code: '310-0010', drSen: 5, crSen: 0 }, { code: '150-0000', drSen: 0, crSen: 5 }],
      { customer: 0, display: 0, service: 0, showroom: 0, others: 0 }, STOCK_CODES);
    expect(lines.some((l) => l.accountCode === OPENING_CLEARING)).toBe(false);
  });
});

describe('openingPaperLines — the import\'s own two lines per paper', () => {
  const party = { code: '400-D002', name: 'DIGLANT' };
  it('a bill owes the supplier against the clearing; a credit the other way round', () => {
    expect(openingPaperLines('API', { docNo: 'HC-API-2608-001', amountSen: 900, party, control: '400-0000' }).map((l) => [l.accountCode, l.debitSen, l.creditSen, l.partyCode ?? null]))
      .toEqual([[OPENING_CLEARING, 900, 0, null], ['400-0000', 0, 900, '400-D002']]);
    expect(openingPaperLines('SCN', { docNo: 'HC-SCN-2608-001', amountSen: 900, party, control: '400-0000' }).map((l) => [l.accountCode, l.debitSen, l.creditSen]))
      .toEqual([['400-0000', 900, 0], [OPENING_CLEARING, 0, 900]]);
  });
  it('an other debtor is named, never coded: a bill owes us, a receipt we owe', () => {
    const debtor = { code: null, name: 'TANGUANYU ENTERPRISE' };
    const odb = openingPaperLines('ODB', { docNo: 'HC-ODB-2608-001', amountSen: 700, party: debtor, control: '305-0000' });
    expect(odb[0]).toMatchObject({ accountCode: '305-0000', debitSen: 700, partyType: 'ODEBTOR', partyCode: null, partyName: 'TANGUANYU ENTERPRISE' });
    const odr = openingPaperLines('ODR', { docNo: 'HC-ODR-2608-001', amountSen: 700, party: debtor, control: '305-0000' });
    expect(odr.map((l) => [l.accountCode, l.debitSen, l.creditSen])).toEqual([[OPENING_CLEARING, 700, 0], ['305-0000', 0, 700]]);
  });
});

describe('checkStock', () => {
  it('whole sen per bucket; an unknown bucket or a part sen is refused', () => {
    expect(checkStock({ customer: 174_416_468 })).toMatchObject({ ok: true, stock: { customer: 174_416_468, display: 0 } });
    expect(checkStock({ shelf: 1 })).toMatchObject({ ok: false });
    expect(checkStock({ customer: -1 })).toMatchObject({ ok: false });
    expect(checkStock({ customer: 1.5 })).toMatchObject({ ok: false });
  });
});
