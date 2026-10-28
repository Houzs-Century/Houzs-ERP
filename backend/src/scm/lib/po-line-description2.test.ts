import { describe, expect, test } from 'vitest';
import { description2InputsChanged } from './po-line-description2';

/* The PO line PATCH rebuilt Description 2 from the spec on EVERY save, so the
   editor's full-line save of a delivery date erased a Description 2 that is not a
   spec summary — the book's migrated Desc2, or one set by the PO line import. */
describe('description2InputsChanged', () => {
  const stored = { item_group: 'bedframe', variants: { fabricCode: 'BF-01', gapInches: 12 } };

  test('the editor re-sending the same spec (keys in another order) does not rebuild it', () => {
    expect(description2InputsChanged(stored, { itemGroup: 'bedframe', variants: { gapInches: 12, fabricCode: 'BF-01' } })).toBe(false);
  });

  test('a save that sends neither input keeps it', () => {
    expect(description2InputsChanged(stored, {})).toBe(false);
  });

  test('an empty variants object and a NULL one are the same spec', () => {
    expect(description2InputsChanged({ item_group: 'others', variants: null }, { itemGroup: 'others', variants: {} })).toBe(false);
  });

  test('a changed spec or category rebuilds it', () => {
    expect(description2InputsChanged(stored, { variants: { fabricCode: 'BF-02', gapInches: 12 } })).toBe(true);
    expect(description2InputsChanged(stored, { itemGroup: 'sofa' })).toBe(true);
    expect(description2InputsChanged({ item_group: 'others', variants: null }, { variants: { specials: ['DRAWER'] } })).toBe(true);
  });
});
