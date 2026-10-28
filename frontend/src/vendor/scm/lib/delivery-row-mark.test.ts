import { describe, expect, it } from 'vitest';
import { ROW_MARK_PALETTE, rowMarkTint } from './delivery-row-mark';

describe('rowMarkTint', () => {
  it('returns the tint for each palette token', () => {
    for (const p of ROW_MARK_PALETTE) expect(rowMarkTint(p.token)).toBe(p.tint);
  });

  it('paints nothing for no mark or an unknown token (a future palette never shows a stale colour)', () => {
    expect(rowMarkTint(null)).toBeUndefined();
    expect(rowMarkTint(undefined)).toBeUndefined();
    expect(rowMarkTint('')).toBeUndefined();
    expect(rowMarkTint('magenta')).toBeUndefined();
  });

  it('offers exactly the eight tokens the backend allow-list stores', () => {
    // Must match backend/src/scm/lib/row-mark-colours.ts ROW_MARK_COLOURS.
    expect(ROW_MARK_PALETTE.map((p) => p.token)).toEqual(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'grey']);
  });
});
