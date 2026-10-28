import { describe, it, expect } from 'vitest';
import {
  num, parseSheetName, findColumns, parseFairSheet, eventToFinanceLines,
  type SheetRows,
} from './fair-report-parse';

// A worksheet in the exact shape of the owner's FAIR REPORT: a 2-row header
// band (r2 spans DATE/AMOUNT/COST/PRICE/MARGIN/SALES PERSON; r3 the cost
// sub-columns MATTRESS/BEDFRAME/ACCESSORIES/ACCESSORIES/SELLING + payment), then
// one row per ORDER. Order figures are REAL rows from
// `27-296AKEMI@PAVILION BUKIT JALI` (selling / MATTRESS+BEDFRAME verified against
// the report's own MARGIN column), with a trailing non-data "COMPLETED" row that
// must be ignored.
const SHEET: SheetRows = [
  Array(20).fill(''),
  ['', '', '', 'DATE', 'ORDER FORM', 'AMOUNT', 'TRANSPORT', 'COST', '', '', 'PRICE', '', 'MARGIN', 'DEPOSIT PAYMENT', '', '', '', 'BALANCE', 'SALES PERSON', ''],
  ['', '', '', '', '', '', '', 'MATTRESS', 'BEDFRAME', 'ACCESSORIES', 'ACCESSORIES', 'SELLING', '', 'CASH', 'CREDIT CARD', 'EPP', 'ONLINE', '', '', ''],
  // order 1: selling 6967, M 2100 + B 1200 (margin 0.5263), acc-cost 342
  ['', '', '', '27/6', 'HC 5981', 7400, '', 2100, 1200, 342, 433, 6967, 0.5263, '', 2220, '', '', 5180, 'SHU HUI', ''],
  // order 2: selling 6175, M 2000 + B 1150 (= 3150), acc-cost 100
  ['', '', '', '27/6', 'HC 5982', 6500, '', 2000, 1150, 100, 150, 6175, 0.4899, '', '', 6175, '', 0, 'SALLY', ''],
  // order 3: selling 9678, M 3000 + B 1620 (= 4620), acc-cost 200
  ['', '', '', '28/6', 'HC 5983', 9999, '', 3000, 1620, 200, 260, 9678, 0.5226, '', 9678, '', '', 0, 'SHU HUI', ''],
  ['', '', '', '', 'COMPLETED', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
];

describe('num', () => {
  it('parses money-ish cells, floors blanks/negatives to 0', () => {
    expect(num(5888.0)).toBe(5888);
    expect(num('5888.0')).toBe(5888);
    expect(num('')).toBe(0);
    expect(num(null)).toBe(0);
    expect(num(-5)).toBe(0);
    expect(num('RM 1,200')).toBe(1200);
  });
});

describe('parseSheetName', () => {
  it('strips the leading date prefix off the brand and splits on @', () => {
    expect(parseSheetName('27-296AKEMI@PAVILION BUKIT JALI')).toEqual({ brand: 'AKEMI', venue: 'PAVILION BUKIT JALI' });
    expect(parseSheetName('19-2411AKEMI@SUTERA MALL')).toEqual({ brand: 'AKEMI', venue: 'SUTERA MALL' });
    expect(parseSheetName('12-1711ZANOTTI@IOI MALL KULAI')).toEqual({ brand: 'ZANOTTI', venue: 'IOI MALL KULAI' });
  });
});

describe('findColumns', () => {
  it('locates SELLING/MATTRESS/BEDFRAME/first-ACCESSORIES/SALES PERSON/DATE', () => {
    const c = findColumns(SHEET);
    expect(c.selling).toBe(11);
    expect(c.mattress).toBe(7);
    expect(c.bedframe).toBe(8);
    expect(c.accessories).toBe(9); // FIRST accessories column (cost), not the 2nd (idx 10)
    expect(c.salesperson).toBe(18);
    expect(c.date).toBe(3);
  });
});

describe('parseFairSheet', () => {
  const ev = parseFairSheet('27-296AKEMI@PAVILION BUKIT JALI', SHEET)!;

  it('aggregates revenue + product COGS from the order rows, ignoring non-data rows', () => {
    expect(ev.orders).toBe(3); // COMPLETED row skipped (no SELLING)
    expect(ev.sales).toBe(6967 + 6175 + 9678);           // 22820
    expect(ev.cogsMattSofa).toBe(2100 + 2000 + 3000);    // 7100
    expect(ev.cogsBedframe).toBe(1200 + 1150 + 1620);    // 3970
    expect(ev.cogsAccessories).toBe(342 + 100 + 200);    // 642 (first ACCESSORIES col)
  });

  it('preserves the report MARGIN identity: (sales - matt - bed) / sales', () => {
    const gp = (ev.sales - ev.cogsMattSofa - ev.cogsBedframe) / ev.sales;
    expect(gp).toBeCloseTo((22820 - 7100 - 3970) / 22820, 6);
  });

  it('rolls salesperson personal sales, sorted high-to-low', () => {
    expect(ev.salespeople).toEqual([
      { name: 'SHU HUI', sales: 6967 + 9678 }, // 16645
      { name: 'SALLY', sales: 6175 },
    ]);
  });

  it('carries brand/venue/date span', () => {
    expect(ev.brand).toBe('AKEMI');
    expect(ev.venue).toBe('PAVILION BUKIT JALI');
    expect(ev.dateFirst).toBe('27/6');
    expect(ev.dateLast).toBe('28/6');
  });

  it('returns null for a blank / non-event sheet', () => {
    expect(parseFairSheet('cover', [Array(10).fill('')])).toBeNull();
    expect(parseFairSheet('empty', [['DATE', 'SELLING'], ['', '']])).toBeNull(); // header but no orders
  });
});

describe('eventToFinanceLines', () => {
  it('emits income/sales + the three product-COGS categories, dropping zeros', () => {
    const ev = parseFairSheet('27-296AKEMI@PAVILION BUKIT JALI', SHEET)!;
    expect(eventToFinanceLines(ev)).toEqual([
      { kind: 'income', category: 'sales', amount: 22820 },
      { kind: 'cost', category: 'cogs_matt_sofa', amount: 7100 },
      { kind: 'cost', category: 'cogs_bedframe', amount: 3970 },
      { kind: 'cost', category: 'cogs_accessories', amount: 642 },
    ]);
  });

  it('drops a zero category (e.g. no accessories)', () => {
    const lines = eventToFinanceLines({
      brand: 'X', venue: 'Y', dateFirst: null, dateLast: null, orders: 1,
      sales: 1000, cogsMattSofa: 400, cogsBedframe: 0, cogsAccessories: 0, salespeople: [],
    });
    expect(lines).toEqual([
      { kind: 'income', category: 'sales', amount: 1000 },
      { kind: 'cost', category: 'cogs_matt_sofa', amount: 400 },
    ]);
  });
});
