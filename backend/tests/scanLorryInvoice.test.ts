import { describe, expect, test } from 'vitest';
import { normalizeDoc, lineSen, reconcile } from '../src/scm/routes/scan-lorry-invoice';

/**
 * The extraction contract for workshop repair documents.
 *
 * The load-bearing test is the last one: a full replay of the real document
 * this endpoint was written for. An OCR pass that drops one line of nineteen
 * produces a record that looks entirely plausible and is quietly wrong by
 * thousands of ringgit — the reconciliation against the PRINTED grand total is
 * what catches that, and it only works if the line model is right.
 */

/** The model's raw output for T FORCE AUTO SERVICES quotation WJO00403, as the
 *  prompt asks for it. Figures transcribed from the document itself. */
const WJO00403 = {
  docKind: 'QUOTATION',
  docNo: 'WJO00403',
  docDate: '2026-07-15',
  workshopName: 'T FORCE AUTO SERVICES SDN BHD',
  workshopRegistrationNo: '202501030334',
  workshopAddress: 'LOT 80, JALAN MAWAR TAMAN PERINDUSTRIAN BUKIT SERDANG, SERI KEMBANGAN',
  workshopEmail: 'Tforce.adm@gmail.com',
  workshopPhone: null,
  advisor: 'JEFF',
  plate: 'VQE9058',
  readyDate: null,
  grandTotalRm: 22208.5,
  confidence: 0.94,
  warnings: ['Ready Date reads "Ready", not a date'],
  lines: [
    { section: 'PART', lineNo: 1, description: 'TO WATER PRESSURE TEST CYLINDER BLOCK', uom: 'PC', qty: 1, unitPriceRm: 280, discountPct: null, amountRm: 280 },
    { section: 'PART', lineNo: 2, description: 'TO WATER PRESSURE TEST CYLINDER HEAD MIT 4D34', uom: 'PC', qty: 1, unitPriceRm: 280, discountPct: null, amountRm: 280 },
    { section: 'PART', lineNo: 3, description: 'TURBOCHARGER ( USED ORI )', uom: 'UNIT', qty: 1, unitPriceRm: 5600, discountPct: 15, amountRm: 4760 },
    { section: 'PART', lineNo: 4, description: 'INJECTOR SERVICE REBUILD', uom: 'PC', qty: 4, unitPriceRm: 1100, discountPct: 15, amountRm: 3740 },
    { section: 'PART', lineNo: 5, description: 'NPR PRO 4HK1 CYLINDER HEAD 16V JAPAN ( USED )', uom: 'UNIT', qty: 1, unitPriceRm: 7500, discountPct: 15, amountRm: 6375 },
    { section: 'PART', lineNo: 6, description: '4HK1 OVERHAUL SET', uom: 'SET', qty: 1, unitPriceRm: 1500, discountPct: 15, amountRm: 1275 },
    { section: 'PART', lineNo: 7, description: 'WATER PUMP ( GMB )', uom: 'UNIT', qty: 1, unitPriceRm: 320, discountPct: 15, amountRm: 272 },
    { section: 'PART', lineNo: 8, description: '4HK1 OIL PUMP ( USED )', uom: 'UNIT', qty: 1, unitPriceRm: 480, discountPct: 15, amountRm: 408 },
    { section: 'PART', lineNo: 9, description: '4HK1 PISTON RING', uom: 'SET', qty: 1, unitPriceRm: 390, discountPct: 15, amountRm: 331.5 },
    { section: 'PART', lineNo: 10, description: '4HK1 PISTON STANDARD', uom: 'PC', qty: 1, unitPriceRm: 400, discountPct: 15, amountRm: 340 },
    { section: 'PART', lineNo: 11, description: '4HK1 CRANKSHAFT BEARING SET', uom: 'SET', qty: 1, unitPriceRm: 210, discountPct: 15, amountRm: 178.5 },
    { section: 'PART', lineNo: 12, description: '4HK1 CONROD BEARING SET ( JAPAN )', uom: 'SET', qty: 1, unitPriceRm: 290, discountPct: 15, amountRm: 246.5 },
    { section: 'PART', lineNo: 13, description: "4HK1 THERMOSTAT 82'", uom: 'PC', qty: 1, unitPriceRm: 230, discountPct: 15, amountRm: 195.5 },
    { section: 'PART', lineNo: 14, description: "4HK1 THERMOSTAT 85'", uom: 'PC', qty: 1, unitPriceRm: 230, discountPct: 15, amountRm: 195.5 },
    { section: 'PART', lineNo: 15, description: 'ENGINE OIL 15W40 ( 1L )', uom: 'LIT', qty: 15, unitPriceRm: 26, discountPct: null, amountRm: 390 },
    { section: 'PART', lineNo: 16, description: 'OIL FILTER', uom: 'PC', qty: 1, unitPriceRm: 48, discountPct: null, amountRm: 48 },
    { section: 'PART', lineNo: 17, description: 'FUEL FILTER', uom: 'PC', qty: 1, unitPriceRm: 48, discountPct: null, amountRm: 48 },
    { section: 'PART', lineNo: 18, description: 'FUEL FILTER', uom: 'PC', qty: 1, unitPriceRm: 45, discountPct: null, amountRm: 45 },
    { section: 'LABOUR', lineNo: 1, description: 'LABOUR CHARGE TO OVERHAUL', uom: 'UNIT', qty: 1, unitPriceRm: 2800, discountPct: null, amountRm: 2800 },
  ],
};

describe('normalizeDoc — coercion, because the model omits fields and sends the wrong primitive', () => {
  test('an empty object yields a usable, empty document rather than throwing', () => {
    const d = normalizeDoc({});
    expect(d.docNo).toBeNull();
    expect(d.lines).toEqual([]);
    expect(d.warnings).toEqual([]);
    expect(d.confidence).toBeNull();
  });
  test('null and non-object input do not throw', () => {
    expect(normalizeDoc(null).lines).toEqual([]);
    expect(normalizeDoc('nonsense').lines).toEqual([]);
  });
  test('a thousands-separated string number is read, not dropped', () => {
    const d = normalizeDoc({ grandTotalRm: '22,208.50', lines: [{ description: 'x', unitPriceRm: '5,600.00' }] });
    expect(d.grandTotalRm).toBe(22208.5);
    expect(d.lines[0]!.unitPriceRm).toBe(5600);
  });
  test('an out-of-range discount is DROPPED, not clamped — a misread column must not zero a line', () => {
    const d = normalizeDoc({ lines: [{ description: 'x', qty: 1, unitPriceRm: 100, discountPct: 150 }] });
    expect(d.lines[0]!.discountPct).toBeNull();
    expect(lineSen(d.lines[0]!)).toBe(10_000); // full price, not 0
  });
  test('a non-ISO or day-first date is refused rather than stored wrong', () => {
    expect(normalizeDoc({ docDate: '15/7/2026' }).docDate).toBeNull();
    expect(normalizeDoc({ docDate: '2026-07-15' }).docDate).toBe('2026-07-15');
  });
  test('the plate is squeezed and uppercased', () => {
    expect(normalizeDoc({ plate: ' vqe 9058 ' }).plate).toBe('VQE9058');
  });
  test('an unknown section falls back to PART', () => {
    expect(normalizeDoc({ lines: [{ description: 'x', section: 'MISC' }] }).lines[0]!.section).toBe('PART');
    expect(normalizeDoc({ lines: [{ description: 'x', section: 'labour' }] }).lines[0]!.section).toBe('LABOUR');
  });
  test('a line with neither description nor amount is dropped as noise', () => {
    const d = normalizeDoc({ lines: [{ description: '', amountRm: null }, { description: 'real', amountRm: 10 }] });
    expect(d.lines).toHaveLength(1);
  });
});

describe('reconcile — the check that catches a dropped line', () => {
  test('no printed total means UNCHECKED (null), which is not the same as agreed', () => {
    const r = reconcile(normalizeDoc({ lines: [{ description: 'x', qty: 1, unitPriceRm: 100 }] }));
    expect(r.printedSen).toBeNull();
    expect(r.matches).toBeNull();
  });
  test('a dropped line fails the check', () => {
    const short = { ...WJO00403, lines: WJO00403.lines.filter((l) => l.lineNo !== 5 || l.section !== 'PART') };
    const r = reconcile(normalizeDoc(short));
    expect(r.matches).toBe(false);
    expect(r.deltaSen).toBe(-637_500); // the missing RM6,375 cylinder head
  });
  test("a vendor's own rounding of a sen does not fail the check", () => {
    const doc = normalizeDoc({
      grandTotalRm: 100.01,
      lines: [{ description: 'a', amountRm: 50 }, { description: 'b', amountRm: 50 }],
    });
    expect(reconcile(doc).matches).toBe(true);
  });
});

describe('the whole document, end to end', () => {
  test('WJO00403 normalises and reconciles to its printed RM22,208.50', () => {
    const doc = normalizeDoc(WJO00403);

    expect(doc.docKind).toBe('QUOTATION');
    expect(doc.docNo).toBe('WJO00403');
    expect(doc.docDate).toBe('2026-07-15');
    expect(doc.workshopRegistrationNo).toBe('202501030334');
    expect(doc.advisor).toBe('JEFF');
    expect(doc.plate).toBe('VQE9058');
    expect(doc.lines).toHaveLength(19);
    expect(doc.lines.filter((l) => l.section === 'LABOUR')).toHaveLength(1);

    const r = reconcile(doc);
    expect(r.linesSen).toBe(2_220_850);
    expect(r.printedSen).toBe(2_220_850);
    expect(r.matches).toBe(true);
    expect(r.deltaSen).toBe(0);
  });

  test('and it still reconciles when the vendor prints no line amounts at all', () => {
    /* Some workshops print only qty / unit / disc and leave Amount blank. The
       computed fallback must land on the same total, or the record would
       silently disagree with the paper depending on the vendor's template. */
    const noAmounts = { ...WJO00403, lines: WJO00403.lines.map((l) => ({ ...l, amountRm: null })) };
    const r = reconcile(normalizeDoc(noAmounts));
    expect(r.linesSen).toBe(2_220_850);
    expect(r.matches).toBe(true);
  });
});
