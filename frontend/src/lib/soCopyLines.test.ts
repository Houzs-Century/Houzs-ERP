import { describe, expect, it } from 'vitest';
import { withoutPwpRewardLines } from './soCopyLines';

describe('copy as new drops PWP reward lines (HC-0149)', () => {
  it('drops a line carrying a single-use pwpCode, keeps the rest', () => {
    const items = [
      { item_code: 'SOFA', variants: { fabricCode: 'F1' } },
      { item_code: 'PILLOW', variants: { pwp: true, pwpCode: 'PWP-1' } },
      { item_code: 'BED', variants: null },
    ];
    expect(withoutPwpRewardLines(items).map((i) => i.item_code)).toEqual(['SOFA', 'BED']);
  });
});
