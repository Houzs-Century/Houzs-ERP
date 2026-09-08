/* F3 / Ctrl+S save (owner 2026-09-08: 像 autocount 按 f3): the window listener
   fires the latest handler, swallows the browser's own key, and does nothing
   while the form says a save makes no sense. */

import { renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { isSaveHotkey, useSaveHotkey } from './use-save-hotkey';

const press = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
  window.dispatchEvent(e);
  return e;
};

describe('isSaveHotkey', () => {
  test('F3 alone, Ctrl+S and ⌘S say yes; a plain s, Alt+F3 and Ctrl+Shift+F3 do not', () => {
    expect(isSaveHotkey({ key: 'F3', ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(isSaveHotkey({ key: 's', ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isSaveHotkey({ key: 'S', ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isSaveHotkey({ key: 's', ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isSaveHotkey({ key: 'F3', ctrlKey: false, metaKey: false, altKey: true })).toBe(false);
    expect(isSaveHotkey({ key: 'F3', ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
  });
});

describe('useSaveHotkey', () => {
  test('F3 and Ctrl+S call the LATEST handler and are swallowed; other keys pass', () => {
    const first = vi.fn();
    const second = vi.fn();
    const hook = renderHook(({ fn }: { fn: () => void }) => useSaveHotkey(fn, true), { initialProps: { fn: first } });
    expect(press({ key: 'F3' }).defaultPrevented).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    hook.rerender({ fn: second });
    expect(press({ key: 's', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(press({ key: 'a' }).defaultPrevented).toBe(false);
    hook.unmount();
    press({ key: 'F3' });
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('disabled, the key is neither acted on nor swallowed', () => {
    const fn = vi.fn();
    renderHook(() => useSaveHotkey(fn, false));
    expect(press({ key: 'F3' }).defaultPrevented).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
