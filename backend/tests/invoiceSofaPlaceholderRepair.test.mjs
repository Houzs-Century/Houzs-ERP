/* The decision behind repair-invoice-source-item-code.mjs.
 *
 * The five rows are real, from probe run 34143079454 (2026-09-08 00:26 local).
 * They are asserted here as data so a refactor that changes the rule has to
 * change a case somebody can read, rather than a count.
 *
 * The rule refuses far more than it repairs on purpose: a wrong item code is
 * worse than a placeholder, and the placeholder is at least honest about not
 * knowing.
 */
import { describe, it, expect } from 'vitest';
import { planInvoicePlaceholderRepair, placeholderModelOf } from '../scripts/lib/invoice-sofa-placeholder-repair.mjs';

/* The SOFA-category erp_codes of the cutover binding, for the four models the
   probe found. The real script reads all of them out of
   scripts/data/autocount-erp-mapping-1561.csv. */
const BINDING = new Set(['5526-1S', '2379-1S', '9058-1S', '8030-1S']);

const forced = (over = {}) => ({
  invoiceNo: 'HC-PI-007551',
  lineId: 'line-1',
  invoiceCode: '9058-1S',
  sourceCode: '9058-1A(LHF)',
  sourceDocNo: 'HC-GR-005068',
  sourceLineCount: 1,
  headerNamesSourceDoc: true,
  ...over,
});

describe('placeholderModelOf', () => {
  it('strips -1S from the END, so a model with its own dash survives', () => {
    expect(placeholderModelOf('SOFA-333 44-1S')).toBe('SOFA-333 44');
    expect(placeholderModelOf('9058-1S')).toBe('9058');
  });
  it('returns null for anything that is not the placeholder shape', () => {
    expect(placeholderModelOf('9058-1A(LHF)')).toBeNull();
    expect(placeholderModelOf('')).toBeNull();
  });
});

describe('planInvoicePlaceholderRepair — the five real rows', () => {
  const rows = [
    { invoiceNo: 'HC-I-000745', lineId: 'a', invoiceCode: '5526-1S', sourceCode: '5526-L(LHF)', sourceDocNo: 'HC-DO-000542', sourceLineCount: 1, headerNamesSourceDoc: true },
    { invoiceNo: 'HC-I-2412-0065', lineId: 'b', invoiceCode: '2379-1S', sourceCode: '2379-2S', sourceDocNo: 'HC-DO-002158', sourceLineCount: 1, headerNamesSourceDoc: true },
    { invoiceNo: 'HC-PI-007551', lineId: 'c', invoiceCode: '9058-1S', sourceCode: '9058-1A(LHF)', sourceDocNo: 'HC-GR-005068', sourceLineCount: 1, headerNamesSourceDoc: true },
    { invoiceNo: 'HC-PI-007917', lineId: 'd', invoiceCode: '9058-1S', sourceCode: '9058-1A(LHF)', sourceDocNo: 'HC-GR-005306', sourceLineCount: 1, headerNamesSourceDoc: true },
    { invoiceNo: 'HC-PI-007920', lineId: 'e', invoiceCode: '8030-1S', sourceCode: '8030-1A(LHF)', sourceDocNo: 'HC-GR-005277', sourceLineCount: 1, headerNamesSourceDoc: true },
  ];

  it('repairs all five, and copies the source code rather than deriving one', () => {
    const { repairs, refusals } = planInvoicePlaceholderRepair(rows, BINDING);
    expect(refusals).toEqual([]);
    expect(repairs).toHaveLength(5);
    expect(repairs.map((r) => r.newCode)).toEqual(
      ['5526-L(LHF)', '2379-2S', '9058-1A(LHF)', '9058-1A(LHF)', '8030-1A(LHF)'],
    );
    /* The new code is the source's, byte for byte. Nothing is decoded. */
    for (const [i, r] of repairs.entries()) expect(r.newCode).toBe(rows[i].sourceCode);
  });
});

describe('planInvoicePlaceholderRepair — what it refuses, and why each matters', () => {
  const only = (row) => planInvoicePlaceholderRepair([row], BINDING);

  it('refuses an invoice code that is not the placeholder shape', () => {
    const { repairs, refusals } = only(forced({ invoiceCode: '9058-CNR' }));
    expect(repairs).toHaveLength(0);
    expect(refusals[0].why).toMatch(/not a \{model\}-1S placeholder/);
  });

  /* THE ONE THAT PROTECTS A CORRECT ROW. A code ending in "-1S" is not
     automatically a placeholder — it is also the real code for a single-seat
     piece. Repairing one of those would overwrite a line that is right. */
  it('refuses a -1S code the cutover binding does not map a sofa onto', () => {
    const { repairs, refusals } = only(forced({ invoiceCode: 'CHAIR-1S' }));
    expect(repairs).toHaveLength(0);
    expect(refusals[0].why).toMatch(/genuine single-seat line/);
  });

  /* A DIFFERENT MODEL is the wrong-link case this script must not touch: it
     needs a human, not a copy. */
  it('refuses a source line of a different model, and says it is a wrong LINK', () => {
    const { repairs, refusals } = only(forced({ sourceCode: '8030-1A(LHF)' }));
    expect(repairs).toHaveLength(0);
    expect(refusals[0].why).toMatch(/wrong LINK, not a placeholder/);
  });

  it('refuses when the source still carries the same placeholder', () => {
    const { refusals } = only(forced({ sourceCode: '9058-1S' }));
    expect(refusals[0].why).toMatch(/nothing to copy/);
  });

  /* TWO LINES MEANS A CHOICE, and a choice is not a repair. */
  it('refuses a source document carrying more than one line', () => {
    const { repairs, refusals } = only(forced({ sourceLineCount: 3 }));
    expect(repairs).toHaveLength(0);
    expect(refusals[0].why).toMatch(/3 lines/);
  });

  it('refuses when the invoice header does not name the source document', () => {
    const { repairs, refusals } = only(forced({ headerNamesSourceDoc: false }));
    expect(repairs).toHaveLength(0);
    expect(refusals[0].why).toMatch(/does not name/);
  });

  it('keeps repairs and refusals in one pass — a refusal never drops a good row', () => {
    const { repairs, refusals } = planInvoicePlaceholderRepair(
      [forced(), forced({ lineId: 'bad', sourceLineCount: 2 })], BINDING);
    expect(repairs).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].lineId).toBe('bad');
  });

  it('compares codes case- and whitespace-insensitively, like every other rule here', () => {
    const { repairs } = only(forced({ invoiceCode: ' 9058-1s ' }));
    expect(repairs).toHaveLength(1);
  });
});
