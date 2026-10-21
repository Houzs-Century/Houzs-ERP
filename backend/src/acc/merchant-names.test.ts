// Which merchant a payment was keyed under (owner 2026-10-21: 「Pinelabs=AEON，
// Public=PBB」): every name a merchant answers to, compared without case.
import { describe, expect, it } from 'vitest';
import { keyedAs, merchantKeyedAs, merchantNamesOf } from './merchant-names';

describe('merchant names', () => {
  it('a merchant answers to its display name first, then its other names — blanks and repeats dropped', () => {
    expect(merchantNamesOf({ display_name: 'AEON', so_names: [' Pinelabs ', '', 'aeon', 'PINELABS'] })).toEqual(['AEON', 'Pinelabs']);
    expect(merchantNamesOf({ display_name: 'MBB' })).toEqual(['MBB']);
    expect(merchantNamesOf({ display_name: 'MBB', so_names: null })).toEqual(['MBB']);
  });

  it('keyed as one of them, whatever the case or the spaces; a blank tag is nobody', () => {
    expect(keyedAs('pinelabs', ['AEON', 'Pinelabs'])).toBe(true);
    expect(keyedAs(' AEON ', ['AEON', 'Pinelabs'])).toBe(true);
    expect(keyedAs('Public', ['AEON', 'Pinelabs'])).toBe(false);
    expect(keyedAs('', ['AEON'])).toBe(false);
    expect(keyedAs(null, ['AEON'])).toBe(false);
  });

  it('finds the one merchant a name belongs to, or none', () => {
    const merchants = [
      { code: 'AEON', display_name: 'AEON', so_names: ['Pinelabs'] },
      { code: 'PBB', display_name: 'PBB', so_names: ['Public'] },
      { code: 'MBB', display_name: 'MBB', so_names: [] },
    ];
    expect(merchantKeyedAs('Public', merchants)?.code).toBe('PBB');
    expect(merchantKeyedAs('Pinelabs', merchants)?.code).toBe('AEON');
    expect(merchantKeyedAs('mbb', merchants)?.code).toBe('MBB');
    expect(merchantKeyedAs('Alliance', merchants)).toBeNull();
  });
});
