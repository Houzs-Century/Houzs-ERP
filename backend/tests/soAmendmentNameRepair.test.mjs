// The pure planner behind the SO-amendment line-name repair
// (backend/scripts/repair-so-amendment-line-names.mjs). The script's DB I/O is
// verified by dispatch (plan first); this pins the decision logic — what it
// fixes, and the three things it must NEVER do (blank a name, touch a correct
// row, or report a missing re-read as clean). docs/bugs/0781.
import { describe, it, expect } from 'vitest';
import { planNameRepairs, verifyNameRepairs } from '../scripts/lib/so-amendment-name-repair.mjs';

describe('planNameRepairs — the SO-amendment line-name repair plan', () => {
  it('fixes a line whose stored name is stale vs the catalogue name of its current code', () => {
    const { toFix, skipped } = planNameRepairs([
      { lineId: 'L1', docNo: 'HC-SO-1', itemCode: '9028-2A(RHF)', description: 'SOFA VERANO 2A(LHF)', catalogName: 'SOFA VERANO 2A(RHF)' },
    ]);
    expect(toFix).toEqual([{ lineId: 'L1', docNo: 'HC-SO-1', itemCode: '9028-2A(RHF)', from: 'SOFA VERANO 2A(LHF)', to: 'SOFA VERANO 2A(RHF)' }]);
    expect(skipped).toEqual([]);
  });

  it('leaves a line already matching the catalogue', () => {
    const { toFix, skipped } = planNameRepairs([
      { lineId: 'L1', docNo: 'HC-SO-1', itemCode: 'ACC-1', description: 'Side Table', catalogName: 'Side Table' },
    ]);
    expect(toFix).toEqual([]);
    expect(skipped).toEqual([{ lineId: 'L1', reason: 'name already matches the catalogue' }]);
  });

  it('NEVER blanks a name — a code with no catalogue row is left and reported', () => {
    const { toFix, skipped } = planNameRepairs([
      { lineId: 'L1', docNo: 'HC-SO-1', itemCode: 'MYSTERY', description: 'Old Name', catalogName: null },
    ]);
    expect(toFix).toEqual([]);
    expect(skipped[0].reason).toMatch(/no catalogue name/);
  });

  it('skips a line that no longer exists', () => {
    const { toFix, skipped } = planNameRepairs([
      { lineId: 'L1', docNo: 'HC-SO-1', itemCode: null, description: null, catalogName: null },
    ]);
    expect(toFix).toEqual([]);
    expect(skipped[0].reason).toMatch(/no longer exists/);
  });
});

describe('verifyNameRepairs — the fresh-connection SHAPE check', () => {
  const toFix = [{ lineId: 'L1', to: 'New Name' }];

  it('passes when every fixed line now carries the written name', () => {
    expect(verifyNameRepairs(toFix, new Map([['L1', 'New Name']]))).toEqual([]);
  });

  it('fails a line the write did not land on', () => {
    expect(verifyNameRepairs(toFix, new Map([['L1', 'Old Name']]))).toEqual(['L1']);
  });

  it('fails a line missing from the re-read (absence is not success)', () => {
    expect(verifyNameRepairs(toFix, new Map())).toEqual(['L1']);
  });
});
