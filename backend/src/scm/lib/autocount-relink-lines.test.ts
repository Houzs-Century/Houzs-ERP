import { describe, expect, test } from 'vitest';
import { planLineRelink, type BookLine, type ErpLineForRelink } from './autocount-relink-lines';

/* Giving a keyless line back the key the account book already has for it.
 *
 * A MISSING key is refused loudly by composeEdit; a WRONG key is not refused at
 * all — it silently edits somebody else's line in a live book on the next save.
 * So every case below is really one question: can this match be PROVEN, and if
 * not, is the refusal narrow enough to leave the other lines repaired?
 */
const erp = (over: Partial<ErpLineForRelink> = {}): ErpLineForRelink => ({
  id: 'row-1', acItemCode: 'AK-APEX MATT (SP)', desc2: null, dtlKey: null, ...over,
});
const book = (over: Partial<BookLine> = {}): BookLine => ({
  DtlKey: 5001, ItemCode: 'AK-APEX MATT (SP)', Desc2: '', ...over,
});

describe('matching a keyless ERP line to the account book', () => {
  test('one unclaimed book line with that code: matched', () => {
    const plan = planLineRelink({
      bookLines: [book({ DtlKey: 991 }), book({ DtlKey: 5099, ItemCode: 'AK-ARISTOI MATT (SP)' })],
      erpLines: [
        erp({ id: 'kept', dtlKey: 991 }),
        erp({ id: 'added', acItemCode: 'AK-ARISTOI MATT (SP)' }),
      ],
    });
    expect(plan.assign).toEqual([{ id: 'added', dtlKey: 5099, itemCode: 'AK-ARISTOI MATT (SP)' }]);
    expect(plan.refused).toEqual([]);
    expect(plan.alreadyKeyed).toBe(1);
  });

  /* The book line our other row already owns is NOT a candidate — otherwise the
     repair would point two ERP rows at one book line. */
  test('a book line another row already claims is never offered', () => {
    const plan = planLineRelink({
      bookLines: [book({ DtlKey: 991 })],
      erpLines: [erp({ id: 'kept', dtlKey: 991 }), erp({ id: 'added' })],
    });
    expect(plan.assign).toEqual([]);
    expect(plan.refused[0]).toContain('no unclaimed line with that item code');
  });

  /* THE SOFA CASE, which is the normal one rather than the edge: several lines
     share a model code and differ only in the build written into Desc2. */
  test('a repeated code is separated by Desc2 when both sides carry one', () => {
    const plan = planLineRelink({
      bookLines: [
        book({ DtlKey: 7001, ItemCode: '9058-1S', Desc2: '2A LHF / GREY' }),
        book({ DtlKey: 7002, ItemCode: '9058-1S', Desc2: '1A RHF / GREY' }),
      ],
      erpLines: [erp({ id: 'added', acItemCode: '9058-1S', desc2: '1A RHF / GREY' })],
    });
    expect(plan.assign).toEqual([{ id: 'added', dtlKey: 7002, itemCode: '9058-1S' }]);
  });

  /* The book truncates its own long builds at 100 characters, so an equality
     test would refuse a legitimate match. */
  test('a Desc2 the book truncated still matches on its prefix', () => {
    const long = 'A'.repeat(120);
    const plan = planLineRelink({
      bookLines: [
        book({ DtlKey: 7001, ItemCode: '9058-1S', Desc2: long.slice(0, 100) }),
        book({ DtlKey: 7002, ItemCode: '9058-1S', Desc2: 'SOMETHING ELSE' }),
      ],
      erpLines: [erp({ id: 'added', acItemCode: '9058-1S', desc2: long })],
    });
    expect(plan.assign).toEqual([{ id: 'added', dtlKey: 7001, itemCode: '9058-1S' }]);
  });

  test('a repeated code with nothing to tell them apart is REFUSED, not guessed', () => {
    const plan = planLineRelink({
      bookLines: [
        book({ DtlKey: 7001, ItemCode: '9058-1S', Desc2: '' }),
        book({ DtlKey: 7002, ItemCode: '9058-1S', Desc2: '' }),
      ],
      erpLines: [erp({ id: 'added', acItemCode: '9058-1S', desc2: null })],
    });
    expect(plan.assign).toEqual([]);
    expect(plan.refused[0]).toContain('no description to tell them apart');
  });

  /* A repair that fixes four of five lines is worth more than one that fixes
     none — as long as the fifth is NAMED. */
  test('one ambiguous line does not stop the others being repaired', () => {
    const plan = planLineRelink({
      bookLines: [
        book({ DtlKey: 7001, ItemCode: '9058-1S', Desc2: '' }),
        book({ DtlKey: 7002, ItemCode: '9058-1S', Desc2: '' }),
        book({ DtlKey: 8001, ItemCode: 'AK-APEX MATT (SP)' }),
      ],
      erpLines: [
        erp({ id: 'sofa', acItemCode: '9058-1S', desc2: null }),
        erp({ id: 'mattress', acItemCode: 'AK-APEX MATT (SP)' }),
      ],
    });
    expect(plan.assign).toEqual([{ id: 'mattress', dtlKey: 8001, itemCode: 'AK-APEX MATT (SP)' }]);
    expect(plan.refused).toHaveLength(1);
  });

  test('two keyless rows of the same code take one book line each, never the same one', () => {
    const plan = planLineRelink({
      bookLines: [
        book({ DtlKey: 7001, ItemCode: '9058-1S', Desc2: 'LEFT' }),
        book({ DtlKey: 7002, ItemCode: '9058-1S', Desc2: 'RIGHT' }),
      ],
      erpLines: [
        erp({ id: 'a', acItemCode: '9058-1S', desc2: 'LEFT' }),
        erp({ id: 'b', acItemCode: '9058-1S', desc2: 'RIGHT' }),
      ],
    });
    expect(plan.assign.map((a) => a.dtlKey).sort()).toEqual([7001, 7002]);
    expect(new Set(plan.assign.map((a) => a.id)).size).toBe(2);
  });
});

/* A SOFA IS ONE BOOK LINE. The ERP holds a build as its compartments; AutoCount
 * holds it as a single detail under `<model>-1S`. Until 2026-09-11 this planner
 * compared the two one-to-one, so every compartment of every build was refused
 * — the `stamped 0` the relink sweep reported with no cause named, and the
 * reason HC-GRN-2609-008's eight 8060 lines could not be repaired by hand
 * either.
 */
describe('a sofa build folds to one book line', () => {
  const compartment = (id: string, code: string, dtlKey: number | null = null): ErpLineForRelink =>
    ({ id, acItemCode: code, desc2: null, dtlKey });

  test('every compartment of the build takes the one book line s key', () => {
    const plan = planLineRelink({
      bookLines: [book({ DtlKey: 7001, ItemCode: '8060-1S' })],
      erpLines: [
        compartment('c1', '8060-1B(LHF)'),
        compartment('c2', '8060-CNR'),
        compartment('c3', '8060-1NA'),
      ],
    });
    expect(plan.assign.map((a) => [a.id, a.dtlKey])).toEqual([['c1', 7001], ['c2', 7001], ['c3', 7001]]);
    expect(plan.refused).toEqual([]);
  });

  /* The build's own kept rows name its book line better than any matcher can:
     one AutoCount line has one DtlKey. */
  test('compartments adopt the key their kept siblings already carry', () => {
    const plan = planLineRelink({
      bookLines: [book({ DtlKey: 7001, ItemCode: '8060-1S' }), book({ DtlKey: 7002, ItemCode: '8060-1S' })],
      erpLines: [
        compartment('kept', '8060-1A(RHF)', 7002),
        compartment('c1', '8060-CNR'),
      ],
    });
    expect(plan.assign).toEqual([{ id: 'c1', dtlKey: 7002, itemCode: '8060-CNR' }]);
    expect(plan.refused).toEqual([]);
  });

  /* Two builds of one model on one document. Telling them apart needs the
     composed build text, which this planner does not hold — so it refuses the
     group rather than handing one build the other's line. */
  test('two unclaimed lines of the same model refuse the whole build', () => {
    const plan = planLineRelink({
      bookLines: [book({ DtlKey: 7001, ItemCode: '9058-1S' }), book({ DtlKey: 7002, ItemCode: '9058-1S' })],
      erpLines: [compartment('c1', '9058-CNR'), compartment('c2', '9058-1NA')],
    });
    expect(plan.assign).toEqual([]);
    expect(plan.refused[0]).toContain('2 unclaimed lines with that item code');
  });

  /* A repair that fixes the ordinary lines and names the sofa is better than
     one that refuses the document whole. */
  test('a refused build leaves the document s ordinary lines repaired', () => {
    const plan = planLineRelink({
      bookLines: [
        book({ DtlKey: 7001, ItemCode: '9058-1S' }),
        book({ DtlKey: 7002, ItemCode: '9058-1S' }),
        book({ DtlKey: 7100, ItemCode: 'HOK-SQUARE PILLOW' }),
      ],
      erpLines: [
        compartment('c1', '9058-CNR'),
        erp({ id: 'pillow', acItemCode: 'HOK-SQUARE PILLOW' }),
      ],
    });
    expect(plan.assign).toEqual([{ id: 'pillow', dtlKey: 7100, itemCode: 'HOK-SQUARE PILLOW' }]);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]).toContain('sofa 9058');
  });

  /* The compartment suffix is what makes a code a sofa. An ordinary hyphenated
     code must keep going through the one-to-one path. */
  test('an ordinary hyphenated code is not treated as a build', () => {
    const plan = planLineRelink({
      bookLines: [book({ DtlKey: 8001, ItemCode: 'AK-BASTION MATT (Q)' })],
      erpLines: [erp({ id: 'm1', acItemCode: 'AK-BASTION MATT (Q)' })],
    });
    expect(plan.assign).toEqual([{ id: 'm1', dtlKey: 8001, itemCode: 'AK-BASTION MATT (Q)' }]);
  });
  /* THE ORDERING IS THE LOAD-BEARING PART. The book does not always fold: a live
     delivery order keeps its 9028 compartments as three lines under their own
     codes (autocountRelinkSweep.test.ts). Folding first would refuse all three
     and lose three provable stamps, so the fold only ever sees a row pass 1
     could find no line for. */
  test('the book s own per-compartment lines win over the fold', () => {
    const plan = planLineRelink({
      bookLines: [
        book({ DtlKey: 5001, ItemCode: '9028-2A(LHF)', Desc2: null }),
        book({ DtlKey: 5002, ItemCode: '9028-L(RHF)', Desc2: null }),
        book({ DtlKey: 5003, ItemCode: '9028-1S', Desc2: null }),
      ],
      erpLines: [compartment('a', '9028-2A(LHF)'), compartment('b', '9028-L(RHF)')],
    });
    expect(plan.assign.map((x) => [x.id, x.dtlKey])).toEqual([['a', 5001], ['b', 5002]]);
    expect(plan.refused).toEqual([]);
  });
});
