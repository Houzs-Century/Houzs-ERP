/* The Finance grids' column widths (batch 6 §1.3): the tracks a grid opens on,
   a width a person set in place of its default, the grid's floor before it
   scrolls sideways, and the widths kept under fin-<kind>-cw until "Reset
   column widths". */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { columnWidthsKey, gridMinWidth, gridTemplate, useColumnWidths } from './useColumnWidths';

const DEFAULTS = ['78px', '108px', 'minmax(200px,1fr)', '96px'] as const;

afterEach(() => { window.localStorage.clear(); });

describe('the tracks', () => {
  test('a set width replaces its default; a grid with no flexible track gets a filler', () => {
    expect(gridTemplate(DEFAULTS, null)).toBe('78px 108px minmax(200px,1fr) 96px');
    expect(gridTemplate(DEFAULTS, [null, 140, null, null])).toBe('78px 140px minmax(200px,1fr) 96px');
    expect(gridTemplate(DEFAULTS, [null, null, 320, null])).toBe('78px 108px 320px 96px minmax(0,1fr)');
  });

  test('the floor adds the widths, the gaps and the row padding', () => {
    expect(gridMinWidth(DEFAULTS, null, 12)).toBe(78 + 108 + 200 + 96 + 3 * 12 + 30);
    expect(gridMinWidth(DEFAULTS, [null, 140, null, null], 8)).toBe(78 + 140 + 200 + 96 + 3 * 8 + 30);
  });
});

describe('useColumnWidths', () => {
  test('reads what was kept, and Reset puts the defaults back', () => {
    window.localStorage.setItem(columnWidthsKey('je'), JSON.stringify([90, null, null, null]));
    const { result } = renderHook(() => useColumnWidths('je', { defaults: DEFAULTS, min: [60, 72, 80, 56] }));
    expect(columnWidthsKey('je')).toBe('fin-je-cw');
    expect(result.current.custom).toBe(true);
    expect(result.current.template).toBe('90px 108px minmax(200px,1fr) 96px');
    expect(result.current.handle(0).title).toBe('Drag to resize · double-click to fit');
    act(() => result.current.reset());
    expect(result.current.custom).toBe(false);
    expect(result.current.template).toBe('78px 108px minmax(200px,1fr) 96px');
    expect(window.localStorage.getItem('fin-je-cw')).toBeNull();
  });

  test('a kept value of the wrong shape is ignored', () => {
    window.localStorage.setItem(columnWidthsKey('gl'), JSON.stringify([90, 'wide']));
    const { result } = renderHook(() => useColumnWidths('gl', { defaults: DEFAULTS, min: [60, 72, 80, 56] }));
    expect(result.current.custom).toBe(false);
  });
});
