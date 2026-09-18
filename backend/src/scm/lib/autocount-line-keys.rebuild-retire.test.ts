import { describe, expect, test } from 'vitest';
import { newLineTargetOf } from './autocount-line-keys';

/* HC-SO-001463's rebuild, sent 2026-09-11 11:31:21Z, as its outbox payload holds
   it (identity fields only): three lines laid down, and TRANSPORTATION CHARGES,
   deleted in the ERP, carried as a retirement. The host skips a Retire line on a
   rebuild (AcSyncService.cs, `if (rebuild && Bool(it, "Retire")) continue;`), so
   the book came back with three lines — and the ERP kept the three dead keys,
   because this function returned null for the whole batch. docs/bugs/0904. */
const rebuildWithRetire = {
  body: {
    Rebuild: true,
    Lines: [
      { DtlKey: 928086, ItemCode: 'AK-SLEEP ESSENTIAL 7 HOLES', ErpLineIds: ['row-sleep'] },
      { DtlKey: 928088, ItemCode: 'AK-BASTION MATT (K)', ErpLineIds: ['row-bastion-k'] },
      { DtlKey: 928089, ItemCode: 'AK-BASTION MATT (Q)', ErpLineIds: ['row-bastion-q'] },
      { DtlKey: 928087, ItemCode: 'TRANSPORTATION CHARGES', Retire: true, Gone: 'deleted' },
    ],
  },
};

describe('newLineTargetOf on a rebuild that retires a line', () => {
  test('names the lines the rebuild lays down, in order, and not the retired one', () => {
    const target = newLineTargetOf('SO', rebuildWithRetire);
    expect(target).not.toBeNull();
    expect(target?.newIds).toEqual([['row-sleep'], ['row-bastion-k'], ['row-bastion-q']]);
    expect(target?.newCodes).toEqual(['AK-SLEEP ESSENTIAL 7 HOLES', 'AK-BASTION MATT (K)', 'AK-BASTION MATT (Q)']);
    expect(target?.knownKeys).toEqual([]);
  });

  test('a laid-down line with no ERP ids still refuses the whole batch', () => {
    const lines = rebuildWithRetire.body.Lines.map((l, i) => (i === 1 ? { DtlKey: l.DtlKey, ItemCode: l.ItemCode } : l));
    expect(newLineTargetOf('SO', { body: { Rebuild: true, Lines: lines } })).toBeNull();
  });

  test('an ordinary edit that retires a line still names nothing new', () => {
    const { Rebuild: _rebuild, ...ordinary } = rebuildWithRetire.body;
    expect(newLineTargetOf('SO', { body: ordinary })).toBeNull();
  });
});
