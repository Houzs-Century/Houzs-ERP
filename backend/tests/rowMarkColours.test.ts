import { describe, expect, test } from 'vitest';
import { ROW_MARK_COLOURS, isRowMarkColour } from '../src/scm/lib/row-mark-colours';

describe('row-mark-colours — the write route allow-list', () => {
  test('accepts every palette token', () => {
    for (const c of ROW_MARK_COLOURS) expect(isRowMarkColour(c)).toBe(true);
  });

  test('rejects anything off the palette so a bad colour can never be stored', () => {
    for (const bad of ['purple', 'RED', '', 'red ', '#d64545', 'green;']) {
      expect(isRowMarkColour(bad)).toBe(false);
    }
  });

  test('is the five tokens the frontend palette mirrors', () => {
    expect([...ROW_MARK_COLOURS]).toEqual(['red', 'amber', 'green', 'blue', 'grey']);
  });
});
