// The packing-list "SCAN WHEN FULLY LOADED" decision, per delivery order (owner,
// 2026-11-27). Pure: what each status does when the whole lorry is scanned.
import { describe, expect, test } from 'vitest';
import {
  LORRY_LOAD_TARGET,
  decideLorryLoad,
  dominantPlate,
  lorryLoadHeadline,
} from '../src/scm/lib/lorry-load-scan';

describe('decideLorryLoad', () => {
  test('the target is the rung after Confirmed, i.e. DB DISPATCHED ("Loaded")', () => {
    expect(LORRY_LOAD_TARGET).toBe('DISPATCHED');
  });

  test('only a Confirmed (LOADED) delivery order is written', () => {
    expect(decideLorryLoad('LOADED', false, false)).toEqual({ action: 'write', from: 'LOADED' });
    expect(decideLorryLoad('loaded', null, false)).toEqual({ action: 'write', from: 'LOADED' });
  });

  test.each([
    ['DISPATCHED', 'ALREADY_DONE'],
    ['IN_TRANSIT', 'PAST'],
    ['DELIVERED', 'PAST'],
    ['SIGNED', 'PAST'],
    ['INVOICED', 'PAST'],
    ['DRAFT', 'BLOCKED'],
    ['CANCELLED', 'BLOCKED'],
    ['SOMETHING_ELSE', 'BLOCKED'],
    [null, 'BLOCKED'],
  ])('%s is left alone as %s', (status, outcome) => {
    const d = decideLorryLoad(status, false, false);
    expect(d.action).toBe('skip');
    expect((d as { outcome: string }).outcome).toBe(outcome);
    expect((d as { message: string }).message).not.toBe('');
  });

  test('a held Confirmed DO is not loaded; a held DO already loaded still reads as loaded', () => {
    const held = decideLorryLoad('LOADED', true, false);
    expect(held).toMatchObject({ action: 'skip', outcome: 'BLOCKED' });
    expect((held as { message: string }).message).toContain('on hold');
    expect(decideLorryLoad('DISPATCHED', true, false)).toMatchObject({ outcome: 'ALREADY_DONE' });
  });

  test('another company\'s DO is never written, whatever its status', () => {
    for (const s of ['LOADED', 'DISPATCHED', 'DRAFT']) {
      expect(decideLorryLoad(s, false, true)).toMatchObject({ action: 'skip', outcome: 'BLOCKED' });
    }
  });
});

describe('the headline', () => {
  test('names the lorry and counts loaded of total', () => {
    expect(lorryLoadHeadline('VJK 8821', 'TRIP-1', 5, 6)).toBe('Lorry VJK 8821: 5 of 6 delivery orders loaded');
    expect(lorryLoadHeadline(null, 'TRIP-1', 1, 1)).toBe('Packing list TRIP-1: 1 of 1 delivery order loaded');
  });

  test('the plate is the one most drops carry; blanks do not count', () => {
    expect(dominantPlate(['A 1', ' ', null, 'B 2', 'A 1'])).toBe('A 1');
    expect(dominantPlate([null, ''])).toBeNull();
  });
});
