import { describe, expect, it } from 'vitest';
import { lineRackSummary } from './grn-line-rack';

const labels: Record<string, string> = { R1: 'L3.1', R2: 'L3.2' };
const labelOf = (id: string) => labels[id];

describe('lineRackSummary — how a line reads on the GRN view page', () => {
  it('lists each rack with its share', () => {
    expect(lineRackSummary([{ rackId: 'R1', qty: 6 }, { rackId: 'R2', qty: 4 }], 10, labelOf))
      .toEqual({ text: 'L3.1 ×6, L3.2 ×4', unplaced: 0 });
  });

  it('says how many are still on no rack', () => {
    expect(lineRackSummary([{ rackId: 'R1', qty: 6 }], 10, labelOf)).toEqual({ text: 'L3.1 ×6', unplaced: 4 });
  });

  it('marks a rack it cannot name instead of hiding it, and reads empty for no rack', () => {
    expect(lineRackSummary([{ rackId: 'R9', qty: 2 }], 2, labelOf).text).toBe('? ×2');
    expect(lineRackSummary([], 5, labelOf)).toEqual({ text: '', unplaced: 5 });
  });
});
