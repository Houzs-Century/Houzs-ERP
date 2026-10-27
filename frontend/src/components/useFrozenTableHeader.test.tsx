/* useFrozenTableHeader — how tall a frozen table may be.
   By default a table with more page below it shrinks so the page's scroll can
   end on it, down to the 240px minimum; on Event Commission, a report of four
   stacked tables, that left each one six rows in a box (owner 2026-10-26:
   这个可以做宽一点吗？ → 做). fillScreen keeps it as tall as the screen allows.
   jsdom lays nothing out, so the geometry the hook measures is given here: an
   800px window, the table's toolbar 50px above its rows, 1,500px of rows, and
   2,000px more page below the table. */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useFrozenTableHeader } from './useFrozenTableHeader';

const Harness = ({ fillScreen }: { fillScreen?: boolean }) => {
  const { rootRef, scrollWrapRef, spacerRef, freezeBox, scrollStyle } = useFrozenTableHeader(true, 'toolbar', fillScreen);
  return (
    <main>
      <div>
        <div ref={rootRef} data-testid="root">
          <div ref={scrollWrapRef} data-testid="wrap" style={scrollStyle} />
          {freezeBox && freezeBox.runway > 0 && <div ref={spacerRef} data-testid="runway" style={{ height: freezeBox.runway }} />}
        </div>
      </div>
    </main>
  );
};

const RECTS: Partial<Record<string, { top: number; bottom: number }>> = {
  root: { top: 300, bottom: 1850 }, // 50px of toolbar, then the rows
  wrap: { top: 350, bottom: 1850 },
};
const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 1200, width: 1200, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = RECTS[this.dataset.testid ?? ''];
    return r ? rect(r.top, r.bottom) : rect(0, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'MAIN' ? 3_000 : this.dataset.testid === 'wrap' ? 1_500 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'MAIN' ? 800 : this.dataset.testid === 'wrap' ? 1_500 : 0;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('how tall a frozen table may be', () => {
  /* The page header clears 64px; the rows start 50px under the table's top:
     the screen leaves 800 − 64 − 50 − 12 = 674px for them. */
  test('by default, with more page below, it shrinks to the 240px minimum', () => {
    render(<Harness />);
    expect(screen.getByTestId('wrap').style.maxHeight).toBe('240px');
  });

  test('fillScreen: as tall as the screen allows, and no runway added below it', () => {
    render(<Harness fillScreen />);
    expect(screen.getByTestId('wrap').style.maxHeight).toBe('674px');
    expect(screen.queryByTestId('runway')).toBeNull();
  });
});
