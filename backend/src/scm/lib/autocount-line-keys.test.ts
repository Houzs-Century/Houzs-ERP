import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { persistLineKeys, type LineKeyTarget } from './autocount-line-keys';

/* STORING THE KEYS IS BEST-EFFORT; STAYING QUIET ABOUT IT WAS THE BUG.
 *
 * Every branch of persistLineKeys that declines to store used to `return` after
 * a console.error, and the drain discarded it. That console goes to a Worker log
 * this account's token cannot read, so a document reached AutoCount reporting
 * SENT while its lines kept NO identity — and that was learned days later, by an
 * operator whose edit was refused whole with "The ERP cannot tell which lines
 * AutoCount already has". docs/bugs/0813.
 *
 * These pin the CONTRACT the drain now depends on: null when the keys landed, a
 * sentence a person can read when they did not.
 */
const row = { op: 'po_to_gr', doc_no: 'HC-GRN-2609-034' };
const target = (over: Partial<LineKeyTarget> = {}): LineKeyTarget => ({
  table: 'grn_items' as LineKeyTarget['table'],
  ids: ['row-1', 'row-2'],
  codes: ['AK-ARMOUR MATT (K)', 'AK-SLEEP ESSENTIAL 7 HOLES'],
  ...over,
});

/** Records every key written, and can be told to fail one row. */
function fakeSb(failIds: string[] = []) {
  const wrote: Array<{ id: string; key: number }> = [];
  const sb = {
    from: () => ({
      update: (patch: { linked_ac_dtlkey: number }) => ({
        eq: async (_col: string, id: string) => {
          if (failIds.includes(id)) return { error: { message: 'row locked' } };
          wrote.push({ id, key: patch.linked_ac_dtlkey });
          return { error: null };
        },
      }),
    }),
  };
  return { sb, wrote };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('persistLineKeys reports why it did not store', () => {
  test('the keys land: null, and every row carries its own', async () => {
    const { sb, wrote } = fakeSb();
    const reason = await persistLineKeys(sb, row, target(), [
      { Seq: 1, DtlKey: 4001, ItemCode: 'AK-ARMOUR MATT (K)' },
      { Seq: 2, DtlKey: 4002, ItemCode: 'AK-SLEEP ESSENTIAL 7 HOLES' },
    ] as never);
    expect(reason).toBeNull();
    expect(wrote).toEqual([{ id: 'row-1', key: 4001 }, { id: 'row-2', key: 4002 }]);
  });

  /* THE ONE THAT COST HC-GRN-2609-034 ITS IDENTITY. An older service, or one
     whose own read-back failed, reports no lines at all. */
  test('AutoCount reported no lines: says so, writes nothing', async () => {
    const { sb, wrote } = fakeSb();
    const reason = await persistLineKeys(sb, row, target(), []);
    expect(reason).toContain('no lines');
    expect(wrote).toEqual([]);
  });

  test('the two lists are different lengths: says so, writes nothing', async () => {
    const { sb, wrote } = fakeSb();
    const reason = await persistLineKeys(sb, row, target(), [
      { Seq: 1, DtlKey: 4001, ItemCode: 'AK-ARMOUR MATT (K)' },
    ] as never);
    expect(reason).toContain('wrong line');
    expect(wrote).toEqual([]);
  });

  test('the codes do not correspond: says so, writes nothing', async () => {
    const { sb, wrote } = fakeSb();
    const reason = await persistLineKeys(sb, row, target(), [
      { Seq: 1, DtlKey: 4001, ItemCode: 'SOMETHING ELSE' },
      { Seq: 2, DtlKey: 4002, ItemCode: 'AK-SLEEP ESSENTIAL 7 HOLES' },
    ] as never);
    expect(reason).toContain('do not correspond');
    expect(wrote).toEqual([]);
  });

  /* A repeated code with no Desc2 on both sides is a guess, and this planner
     does not guess — a wrong DtlKey edits somebody else's line. */
  test('a repeated code with nothing to separate it: says so, writes nothing', async () => {
    const { sb, wrote } = fakeSb();
    const reason = await persistLineKeys(
      sb, row, target({ codes: ['HOK-SQUARE PILLOW', 'HOK-SQUARE PILLOW'] }),
      [
        { Seq: 1, DtlKey: 4001, ItemCode: 'HOK-SQUARE PILLOW' },
        { Seq: 2, DtlKey: 4002, ItemCode: 'HOK-SQUARE PILLOW' },
      ] as never,
    );
    expect(reason).toContain('more than one line');
    expect(wrote).toEqual([]);
  });

  /* A PARTIAL IS AS COSTLY AS A CLEAN MISS: composeEdit refuses a document with
     ANY keyless line, so one failed write loses the whole document its next
     edit. It must not report success. */
  test('one row fails to write: reports the partial rather than passing', async () => {
    const { sb, wrote } = fakeSb(['row-2']);
    const reason = await persistLineKeys(sb, row, target(), [
      { Seq: 1, DtlKey: 4001, ItemCode: 'AK-ARMOUR MATT (K)' },
      { Seq: 2, DtlKey: 4002, ItemCode: 'AK-SLEEP ESSENTIAL 7 HOLES' },
    ] as never);
    expect(reason).toContain('only part');
    expect(wrote).toEqual([{ id: 'row-1', key: 4001 }]);
  });
});
