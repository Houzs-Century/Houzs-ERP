// HOOKKA DO-2611-035 against HC-PO-2609-235 (owner 2026-11-10): five rows of
// SQUARE PILLOW (16"x16") (CUSTOM) printed COVE-09, COVE-09, COVE-09, COVE-13,
// COVE-13; the PO holds HOK-SQUARE PILLOW twice, COVE-13 owing 2 and COVE-09
// owing 3, the colour only in each line's variants. Paper COVE-09 rows were tied
// to the COVE-13 line and the other way round.
import { describe, expect, test } from 'vitest';
import { buildReview, inPrintedOrder, racksOf, suggestByName, type ReviewLine } from './grn-scan-check';
import { byPrintedColour, lineColours, printedColours } from './grn-scan-colour';
import { matchGrnScanToPoLines, type GrnMatchResult, type OpenPoLine, type ScannedGrnLine } from './grn-scan-match';

const PO = 'HC-PO-2609-235';
const pillow = (poItemId: string, colour: string, remaining: number): OpenPoLine => ({
  poItemId, poId: PO, poNumber: PO, supplierId: 'hookka', itemCode: 'HOK-SQUARE PILLOW', materialName: null, supplierSku: null,
  remaining, locationCode: 'KL WAREHOUSE', description2: null, colours: [colour],
});
// The PO's order: COVE-13 first, then COVE-09.
const open = [pillow('c13', 'COVE-13', 2), pillow('c09', 'COVE-09', 3)];
const DESC = (c: string) => `SQUARE PILLOW (16"x16") (CUSTOM) ${c}`;
const PAPER = ['COVE-09', 'COVE-09', 'COVE-09', 'COVE-13', 'COVE-13'];

describe('the colour of a PO line', () => {
  test('comes from its variants, the supplier code too', () => {
    expect(lineColours({ fabricCode: 'COVE-13', fabricSupplierCode: 'KN390-1' })).toEqual(['COVE-13', 'KN390-1']);
    expect(lineColours('{"fabricColor":"BF-02"}')).toEqual(['BF-02']);
    expect(lineColours(null)).toEqual([]);
  });
  test('a printed colour is read the ways it is written; a size is not a colour', () => {
    expect([...printedColours(DESC('COVE-09'), open)]).toEqual(['COVE 9']);
    expect([...printedColours('square pillow cove 9', open)]).toEqual(['COVE 9']);
    // Another number of the same series is a colour, and agrees with neither line.
    expect(byPrintedColour(DESC('COVE-11'), open)).toEqual([]);
    expect(byPrintedColour('SQUARE PILLOW (16"x16")', open)).toEqual(open);
  });
});

describe('the check screen ties each row to the line of its own colour (DO-2611-035)', () => {
  const rows = (): ReviewLine[] => PAPER.map((c, i) => ({
    key: `r${i}`, poItemId: null, poNumber: null, gift: null, qty: 1, rack: null, suggested: false,
    read: { itemCode: null, description: DESC(c), qty: 1, poNo: null },
  }));
  test('by name: COVE-09 rows to the COVE-09 line, COVE-13 rows to the COVE-13 line', () => {
    const lines = rows();
    suggestByName(lines, open, [PO]);
    expect(lines.map((l) => l.poItemId)).toEqual(['c09', 'c09', 'c09', 'c13', 'c13']);
  });
  test('a fourth COVE-09 row is never put on the COVE-13 line that still owes', () => {
    const lines = [...rows(), { ...rows()[0], key: 'extra' }];
    suggestByName(lines, open, [PO]);
    expect(lines[5].poItemId).toBeNull();
  });
  test('a row with no printed colour still ties, as before', () => {
    const lines: ReviewLine[] = [{ key: 'x', poItemId: null, poNumber: null, gift: null, qty: 1, rack: null, suggested: false, read: { itemCode: null, description: 'SQUARE PILLOW (16"x16") (CUSTOM)', qty: 1, poNo: null } }];
    suggestByName(lines, open, [PO]);
    expect(lines[0].poItemId).toBe('c13');
  });
  test('the matcher, PO printed: each row on the line of its colour', () => {
    const scanned: ScannedGrnLine[] = PAPER.map((c) => ({ itemCode: null, barcode: null, description: DESC(c), qty: 1, poNo: null, rack: null }));
    const res = matchGrnScanToPoLines(PO, scanned, open, [], 'hookka');
    expect(res.picks).toEqual([{ poItemId: 'c09', qty: 3 }, { poItemId: 'c13', qty: 2 }]);
    expect(res.unmatched).toEqual([]);
  });
  test('the matcher by code: a colour on no open line is left for the operator, never the other colour', () => {
    const scanned: ScannedGrnLine[] = [{ itemCode: 'HOK-SQUARE PILLOW', barcode: null, description: DESC('COVE-11'), qty: 1, poNo: null, rack: null }];
    const res = matchGrnScanToPoLines(PO, scanned, open, [], 'hookka');
    expect(res.picks).toEqual([]);
    expect(res.unmatched.map((u) => [u.reason, u.candidatePoItemIds])).toEqual([['colour_not_on_po', []]]);
    const byCode = matchGrnScanToPoLines(PO, [{ ...scanned[0], description: DESC('COVE-13') }], open, [], 'hookka');
    expect(byCode.picks).toEqual([{ poItemId: 'c13', qty: 1 }]);
  });
  test('a matched line shows the paper row of its own colour', () => {
    // Rows printing our code, so each could be either line by code alone.
    const printed = PAPER.map((c) => ({ itemCode: 'HOK-SQUARE PILLOW', barcode: null, description: DESC(c), qty: 1, poNo: null, rack: null }));
    const lines: ReviewLine[] = [
      { key: 'a', poItemId: 'c13', poNumber: null, gift: null, qty: 2, rack: null, suggested: false, read: null },
      { key: 'b', poItemId: 'c09', poNumber: null, gift: null, qty: 3, rack: null, suggested: false, read: null },
    ];
    const out = inPrintedOrder(lines, printed, open, new Set());
    expect(out.map((l) => [l.poItemId, l.read?.description])).toEqual([['c09', DESC('COVE-09')], ['c13', DESC('COVE-13')]]);
  });
});

describe('split rows of one PO line onto two racks (owner 2026-11-10)', () => {
  test('the check screen holds one line per rack and Create carries each rack its qty', () => {
    const parsed = { supplierName: 'HOOKKA', poNo: PO, doNo: 'DO-1', deliveryDate: null, lines: [] };
    const match = { picks: [{ poItemId: 'c09', qty: 3 }], racks: {}, rackQty: { c09: { 'LH6-1': 2, 'LV6-1': 1 } }, unmatched: [], soMatches: [] } as unknown as GrnMatchResult;
    const review = buildReview(parsed, 'hookka', match, [], open, '2026-11-10');
    expect(review.lines.map((l) => [l.poItemId, l.rack, l.qty])).toEqual([['c09', 'LH6-1', 2], ['c09', 'LV6-1', 1]]);
    expect(racksOf(review)).toEqual({ c09: { 'LH6-1': 2, 'LV6-1': 1 } });
  });
});
