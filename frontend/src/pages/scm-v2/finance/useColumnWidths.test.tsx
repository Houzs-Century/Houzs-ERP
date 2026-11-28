import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { columnWidthsKey, gridMinWidth, gridTemplate, useColumnWidths } from './useColumnWidths';

const DEFAULTS = ['78px', '108px', 'minmax(200px,1fr)', '96px'] as const;

afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

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

  /* A form grid (the AP invoice's lines, owner 2026-11-16): each cell is a text
     box exactly as wide as its column, so a double-click fits to the box's TEXT. */
  test('a double-click fits a column of text boxes to the longest text the boxes show, padding included', () => {
    const measure = (t: string) => [...t].reduce((s, c) => s + (/[A-Z]/.test(c) ? 9 : 7), 0);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ font: '', measureText: (t: string) => ({ width: measure(t) }) } as unknown as CanvasRenderingContext2D);
    const FormGrid = () => {
      const cw = useColumnWidths('fx', { defaults: ['minmax(120px,1fr)', '80px'], min: [100, 60] });
      return (
        <div data-cw-root="fx">
          <div data-cw-row="" style={{ gridTemplateColumns: cw.template }}>
            <span data-cw-cell={0}><span data-cw-lbl="">Description</span><span {...cw.handle(0)} /></span>
            <span data-cw-cell={1}><span data-cw-lbl="">Amount</span></span>
          </div>
          <div data-cw-row="" style={{ gridTemplateColumns: cw.template }}>
            <span><input aria-label="one" defaultValue="transport fee" style={{ padding: '0 10px', border: '1px solid', textTransform: 'uppercase' }} /></span>
            <span><input type="text" aria-label="one amount" defaultValue="1,300.00" /></span>
          </div>
          <div data-cw-row="" style={{ gridTemplateColumns: cw.template }}>
            <span><input aria-label="two" placeholder="a note" style={{ padding: '0 10px' }} /></span>
            <span><input type="checkbox" aria-label="two ticked" /></span>
          </div>
        </div>
      );
    };
    render(<FormGrid />);
    fireEvent.doubleClick(screen.getByTitle('Drag to resize · double-click to fit'));
    expect(JSON.parse(window.localStorage.getItem('fin-fx-cw') ?? 'null')).toEqual([Math.ceil(measure('TRANSPORT FEE') + 20 + 2) + 2, null]);
  });
});
