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
