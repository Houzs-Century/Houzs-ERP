// useLocalStorage's key can MOVE after mount (DataTable layout keys gain a
// `c<company>:` prefix once the active company resolves). These pin the two
// halves of the contract that make that survivable:
//   1. a genuine key change RE-READS storage — and does NOT copy the old
//      key's value over the new key's saved one;
//   2. a same-key re-render never re-reads, so an edit already on screen is
//      never clobbered by storage changing behind the component's back.
// Before the fix, (1) failed both ways: the state kept the old key's value
// AND the write effect immediately overwrote the new key's saved value with
// it — "the layout resets on every open" (DataGrid's twin, 2026-08-20).

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

    // Mount under the UNSCOPED key — the company is not resolved yet.
    const { result, rerender } = renderWithKey('dt:hidden:orders');
    expect(result.current[0]).toEqual([]);

    // /auth/me lands; the key gains its company prefix.
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
    // First load after company scoping shipped: the scoped key is empty and
    // the user's pre-scoping columns live under the unscoped one.
    localStorage.setItem('dt:hidden:orders', JSON.stringify(['carried']));

    const { result, rerender } = renderWithKey('dt:hidden:orders');
    rerender({ key: 'dt:hidden:c2:orders', legacy: 'dt:hidden:orders' });

    expect(result.current[0]).toEqual(['carried']);
  });

  it('never re-reads while the key is unchanged', () => {
    const { result, rerender } = renderWithKey('dt:hidden:orders');
    act(() => result.current[1](['edited']));

    // Storage changes behind the component's back — no key change, no re-read.
    localStorage.setItem('dt:hidden:orders', JSON.stringify(['external']));
    rerender({ key: 'dt:hidden:orders', legacy: undefined });

    expect(result.current[0]).toEqual(['edited']);
  });
});
