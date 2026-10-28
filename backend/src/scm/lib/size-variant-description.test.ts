import { describe, it, expect } from 'vitest';
import { correctedSizeDescription, type SizeSkuRow } from './size-variant-description';

/* The real 2990 mattress family that exposed the bug (2990-PO-2608-005): five
   sizes under one Model, each with its OWN dimensions in the name. The POS
   catalog card is the K row, so the K name is what a mis-snapshotted line of
   any size carries. */
const row = (over: Partial<SizeSkuRow> & Pick<SizeSkuRow, 'code' | 'name'>): SizeSkuRow => ({
  model_id: 'model-arrus-firm',
  base_model: 'ARRUS-FIRM',
  category: 'MATTRESS',
  size_code: 'K',
  ...over,
});

const ARRUS = [
  row({ code: '2990 ARRUS-FIRM MATT (K)',  name: '2990 ARRUS-FIRM MATTRESS (183X190X30CM)', size_code: 'K' }),
  row({ code: '2990 ARRUS-FIRM MATT (Q)',  name: '2990 ARRUS-FIRM MATTRESS (152X190X30CM)', size_code: 'Q' }),
  row({ code: '2990 ARRUS-FIRM MATT (S)',  name: '2990 ARRUS-FIRM MATTRESS (90X190X30CM)',  size_code: 'S' }),
  row({ code: '2990 ARRUS-FIRM MATT (SS)', name: '2990 ARRUS-FIRM MATTRESS (107X190X30CM)', size_code: 'SS' }),
];

const mapOf = (rows: SizeSkuRow[]) => new Map(rows.map((r) => [r.code, r]));

describe('correctedSizeDescription', () => {
  const byCode = mapOf(ARRUS);

  it('corrects a Queen line that carries the King name (the shipped bug)', () => {
    expect(correctedSizeDescription(
      '2990 ARRUS-FIRM MATT (Q)',
      '2990 ARRUS-FIRM MATTRESS (183X190X30CM)',
      byCode,
    )).toBe('2990 ARRUS-FIRM MATTRESS (152X190X30CM)');
  });

  it('corrects Single and Super-single the same way', () => {
    const king = '2990 ARRUS-FIRM MATTRESS (183X190X30CM)';
    expect(correctedSizeDescription('2990 ARRUS-FIRM MATT (S)', king, byCode))
      .toBe('2990 ARRUS-FIRM MATTRESS (90X190X30CM)');
    expect(correctedSizeDescription('2990 ARRUS-FIRM MATT (SS)', king, byCode))
      .toBe('2990 ARRUS-FIRM MATTRESS (107X190X30CM)');
  });

  it('leaves the King line alone — it was already right', () => {
    expect(correctedSizeDescription(
      '2990 ARRUS-FIRM MATT (K)',
      '2990 ARRUS-FIRM MATTRESS (183X190X30CM)',
      byCode,
    )).toBeNull();
  });

  it('matches through surrounding whitespace', () => {
    expect(correctedSizeDescription(
      '2990 ARRUS-FIRM MATT (Q)',
      '  2990 ARRUS-FIRM MATTRESS (183X190X30CM) ',
      byCode,
    )).toBe('2990 ARRUS-FIRM MATTRESS (152X190X30CM)');
  });

  it('never touches a hand-written description', () => {
    // The whole reason the rule is "verbatim another size's name" and not
    // "differs from the master name": sales edit these on purpose.
    expect(correctedSizeDescription(
      '2990 ARRUS-FIRM MATT (Q)',
      'ARRUS Queen — customer wants the firmer top layer',
      byCode,
    )).toBeNull();
  });

  it('never touches a blank description', () => {
    expect(correctedSizeDescription('2990 ARRUS-FIRM MATT (Q)', '', byCode)).toBeNull();
    expect(correctedSizeDescription('2990 ARRUS-FIRM MATT (Q)', null, byCode)).toBeNull();
    expect(correctedSizeDescription('2990 ARRUS-FIRM MATT (Q)', undefined, byCode)).toBeNull();
  });

  it('never touches an unsized SKU (a service / accessory line)', () => {
    const svc = mapOf([
      row({ code: 'SVC-DELIVERY', name: 'Delivery fee', size_code: null, model_id: null, base_model: null }),
    ]);
    expect(correctedSizeDescription('SVC-DELIVERY', 'Delivery fee (special model)', svc)).toBeNull();
  });

  it('never touches a code that is not in the master', () => {
    expect(correctedSizeDescription('MYSTERY-SKU', 'anything at all', byCode)).toBeNull();
  });

  it('does not cross Models — another product that happens to be sized is not a sibling', () => {
    const mixed = mapOf([
      ...ARRUS,
      row({
        code: '2990 AKKA-SOFT MATT (K)', name: '2990 AKKA-SOFT MATTRESS (183X190X31CM)',
        model_id: 'model-akka-soft', base_model: 'AKKA-SOFT',
      }),
    ]);
    // AKKA's name on an ARRUS line is not a size mix-up — leave it for a human.
    expect(correctedSizeDescription(
      '2990 ARRUS-FIRM MATT (Q)',
      '2990 AKKA-SOFT MATTRESS (183X190X31CM)',
      mixed,
    )).toBeNull();
  });

  it('sibling-matches on base_model + category for pre-product_models rows', () => {
    const legacy = mapOf([
      row({ code: 'LEG-(K)', name: 'LEGACY MATTRESS (183X190CM)', model_id: null, size_code: 'K' }),
      row({ code: 'LEG-(Q)', name: 'LEGACY MATTRESS (152X190CM)', model_id: null, size_code: 'Q' }),
    ]);
    expect(correctedSizeDescription('LEG-(Q)', 'LEGACY MATTRESS (183X190CM)', legacy))
      .toBe('LEGACY MATTRESS (152X190CM)');
  });

  it('leaves the line alone when the booked SKU has no master name to correct to', () => {
    const nameless = mapOf([
      row({ code: 'X-(Q)', name: null, size_code: 'Q' }),
      row({ code: 'X-(K)', name: 'X MATTRESS (183X190CM)', size_code: 'K' }),
    ]);
    expect(correctedSizeDescription('X-(Q)', 'X MATTRESS (183X190CM)', nameless)).toBeNull();
  });
});
