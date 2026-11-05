/* The date picker opens fully on screen (owner 2026-11-04: its calendar ran
   under the sidebar, cut off on the left). */
import { describe, expect, it } from 'vitest';
import { placePopover, POPOVER_MARGIN } from './popoverPlacement';

const trigger = (left: number, width = 260, top = 100) => ({ left, right: left + width, top, bottom: top + 32 });

describe('placePopover', () => {
  it('opens under the trigger with its left edge on the trigger’s when it fits', () => {
    expect(placePopover(trigger(300), 560, 420, 1440, 900)).toEqual({ left: 300, top: 138 });
  });

  it('lines up with the trigger’s right edge when the left-aligned box would run off the right', () => {
    const t = trigger(1100);
    expect(placePopover(t, 560, 420, 1440, 900).left).toBe(t.right - 560);
  });

  it('never starts left of the window margin: the case the sidebar hid', () => {
    /* A trigger near the left edge whose right-aligned box would start at -200. */
    expect(placePopover(trigger(100, 260), 560, 420, 600, 900).left).toBe(POPOVER_MARGIN);
  });

  it('never runs past the right margin', () => {
    const p = placePopover(trigger(500), 560, 420, 900, 900);
    expect(p.left + 560).toBeLessThanOrEqual(900 - POPOVER_MARGIN);
  });

  it('opens above when there is no room below but room above', () => {
    expect(placePopover(trigger(300, 260, 700), 560, 420, 1440, 900).top).toBe(700 - 6 - 420);
  });

  it('stays below when there is room neither above nor below', () => {
    expect(placePopover(trigger(300, 260, 200), 560, 800, 1440, 900).top).toBe(238);
  });
});
