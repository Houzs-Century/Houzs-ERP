import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared with the backfill script
import { pairDoLinesToSoLines, variantIdentity } from '../scripts/lib/do-so-item-pairing.mjs';

/* The pairing that repairs a Delivery Order line's lost link to its Sales Order
   line. The repair writes into delivery history, so the interesting cases are
   the ones where it must REFUSE: a wrong link credits one line's shipment
   against another and is indistinguishable from a fact afterwards, while a
   missing link stays visible as the shortage it causes.

   A vitest file rather than node:test on purpose — the coverage ratchet reads
   vitest reports only, and a module it cannot see it reports as untested. */

const so = (id: string, item_code: string, extra: Record<string, unknown> = {}) =>
  ({ id, doc_no: 'SO-1', item_code, qty: 1, ...extra });
const doLine = (id: string, item_code: string, extra: Record<string, unknown> = {}) =>
  ({ id, so_doc_no: 'SO-1', item_code, qty: 1, ...extra });

describe('pairDoLinesToSoLines', () => {
  test('the common case: one DO line, one SO line of that code', () => {
    const { pairs, unresolved } = pairDoLinesToSoLines(
      [doLine('d1', 'XAMMAR-L(LHF)')],
      [so('s1', 'XAMMAR-L(LHF)')],
    );
    expect(unresolved).toEqual([]);
    expect(pairs).toEqual([
      { doItemId: 'd1', soItemId: 's1', so_doc_no: 'SO-1', item_code: 'XAMMAR-L(LHF)', how: 'only line of its code' },
    ]);
  });

  test('two lines of the same code pair on the colour BOTH documents carry', () => {
    // 2990-SO-2606-016 / 2990-DO-2608-005: two CODY-(K), BF-10 and BF-12.
    const dos = [
      doLine('d-bf12', 'CODY-(K)', { variants: { colourId: 'BF-12', pwpCode: 'PWP-2995KJGU' } }),
      doLine('d-bf10', 'CODY-(K)', { variants: { colourId: 'BF-10', pwpCode: 'PWP-3085SIOZ' } }),
    ];
    const sos = [
      so('s-bf10', 'CODY-(K)', { variants: { colourId: 'BF-10', pwpCode: 'PWP-3085SIOZ' } }),
      so('s-bf12', 'CODY-(K)', { variants: { colourId: 'BF-12', pwpCode: 'PWP-2995KJGU' } }),
    ];
    const { pairs, unresolved } = pairDoLinesToSoLines(dos, sos);
    expect(unresolved).toEqual([]);
    // Crossed, not positional — the DO lists BF-12 first, the SO lists BF-10 first.
    expect(Object.fromEntries(pairs.map((p: { doItemId: string; soItemId: string }) => [p.doItemId, p.soItemId])))
      .toEqual({ 'd-bf12': 's-bf12', 'd-bf10': 's-bf10' });
  });

  test('refuses two same-code lines that carry no distinguishing variant', () => {
    const { pairs, unresolved } = pairDoLinesToSoLines(
      [doLine('d1', 'CODY-(K)'), doLine('d2', 'CODY-(K)')],
      [so('s1', 'CODY-(K)'), so('s2', 'CODY-(K)')],
    );
    expect(pairs).toEqual([]);           // an arbitrary bijection is still a guess
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].reason).toMatch(/do not pair one-to-one/);
  });

  test('refuses when two lines claim the SAME identity', () => {
    const v = { variants: { colourId: 'BF-10' } };
    const { pairs, unresolved } = pairDoLinesToSoLines(
      [doLine('d1', 'CODY-(K)', v), doLine('d2', 'CODY-(K)', v)],
      [so('s1', 'CODY-(K)', v), so('s2', 'CODY-(K)', v)],
    );
    expect(pairs).toEqual([]);
    expect(unresolved).toHaveLength(1);
  });

  test('refuses a DO line whose code is on no SO line at all', () => {
    const { pairs, unresolved } = pairDoLinesToSoLines([doLine('d1', 'GHOST-ITEM')], [so('s1', 'CODY-(K)')]);
    expect(pairs).toEqual([]);
    expect(unresolved[0].reason).toBe('no SO line with this item code');
  });

  test('never pairs across sales orders', () => {
    const { pairs, unresolved } = pairDoLinesToSoLines(
      [{ id: 'd1', so_doc_no: 'SO-1', item_code: 'CODY-(K)', qty: 1 }],
      [{ id: 's1', doc_no: 'SO-2', item_code: 'CODY-(K)', qty: 1 }],
    );
    expect(pairs).toEqual([]);           // SO-2's line is not a candidate for SO-1's delivery
    expect(unresolved).toHaveLength(1);
  });

  test('an item code containing spaces groups and reports intact', () => {
    /* Real codes look like this. A key joined on a single character cannot be
       taken apart again, so the group carries its own fields instead. */
    const code = '2990 ARRUS-FIRM MATT (Q)';
    const { pairs, unresolved } = pairDoLinesToSoLines([doLine('d1', code)], [so('s1', code)]);
    expect(unresolved).toEqual([]);
    expect(pairs[0].item_code).toBe(code);
    expect(pairs[0].so_doc_no).toBe('SO-1');

    // …and on the refusal path, which is where a mangled code would be printed
    // at a human and quietly believed.
    const miss = pairDoLinesToSoLines([doLine('d1', code)], []);
    expect(miss.unresolved[0].item_code).toBe(code);
    expect(miss.unresolved[0].so_doc_no).toBe('SO-1');
  });
});

describe('variantIdentity', () => {
  test('prefers the most specific field available', () => {
    expect(variantIdentity({ variants: { pwpCode: 'P1', colourId: 'C1' } })).toBe('pwp:P1');
    expect(variantIdentity({ variants: { colourId: 'C1' } })).toBe('colour:C1');
    expect(variantIdentity({ description2: 'BF-10 / DIVAN 8"' })).toBe('d2:BF-10 / DIVAN 8"');
    expect(variantIdentity({})).toBe('');
    // An array-shaped variants blob (the jsonb double-encoding COE) is not an
    // identity — it must fall through, not throw.
    expect(variantIdentity({ variants: [] })).toBe('');
  });
});
