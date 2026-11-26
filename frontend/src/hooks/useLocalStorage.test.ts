
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLocalStorage } from './useLocalStorage';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

const renderWithKey = (initialKey: string, legacyKey?: string) =>
  renderHook(({ key, legacy }) => useLocalStorage<string[]>(key, [], legacy), {
    initialProps: { key: initialKey, legacy: legacyKey },
  });

describe('useLocalStorage when the key moves after mount', () => {
  it('re-reads the new key instead of keeping the old key’s value', () => {
    localStorage.setItem('dt:hidden:c2:orders', JSON.stringify(['phone']));

    const { result, rerender } = renderWithKey('dt:hidden:orders');
    expect(result.current[0]).toEqual([]);

    rerender({ key: 'dt:hidden:c2:orders', legacy: undefined });
    expect(result.current[0]).toEqual(['phone']);
  });

  it('does not overwrite the new key’s saved value with the old key’s', () => {
    localStorage.setItem('dt:hidden:orders', JSON.stringify(['old']));
    localStorage.setItem('dt:hidden:c2:orders', JSON.stringify(['saved']));

    const { rerender } = renderWithKey('dt:hidden:orders');
    rerender({ key: 'dt:hidden:c2:orders', legacy: undefined });

    expect(JSON.parse(localStorage.getItem('dt:hidden:c2:orders')!)).toEqual(['saved']);
  });

  it('falls back to the legacy key when the new key holds nothing', () => {
    localStorage.setItem('dt:hidden:orders', JSON.stringify(['carried']));

    const { result, rerender } = renderWithKey('dt:hidden:orders');
    rerender({ key: 'dt:hidden:c2:orders', legacy: 'dt:hidden:orders' });

    expect(result.current[0]).toEqual(['carried']);
  });

  it('never re-reads while the key is unchanged', () => {
    const { result, rerender } = renderWithKey('dt:hidden:orders');
    act(() => result.current[1](['edited']));

    localStorage.setItem('dt:hidden:orders', JSON.stringify(['external']));
    rerender({ key: 'dt:hidden:orders', legacy: undefined });

    expect(result.current[0]).toEqual(['edited']);
  });
});
