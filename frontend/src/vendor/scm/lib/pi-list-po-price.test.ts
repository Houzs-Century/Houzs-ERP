/* The list marker for "was this invoice billed at the purchase order's prices"
   (owner 2026-09-14: 「在外面的界面 UI 上，能直接看到」). Information only. */
import { describe, expect, test } from 'vitest';
import { poPriceMarker } from './pi-list-po-price';

describe('poPriceMarker', () => {
  test('not loaded yet -> nothing (never a reassuring guess)', () => {
    expect(poPriceMarker(undefined)).toBeNull();
  });
  test('some lines differ -> names how many, and the net amount', () => {
    expect(poPriceMarker({ linesDiffering: 2, totalDiffSen: 8_000, comparableLines: 3, lines: 3 }))
      .toEqual({ label: '2 lines differ', tone: 'differs', diffSen: 8_000 });
    expect(poPriceMarker({ linesDiffering: 1, totalDiffSen: -500, comparableLines: 1, lines: 4 }))
      .toEqual({ label: '1 line differs', tone: 'differs', diffSen: -500 });
  });
  test('every comparable line agrees -> matches', () => {
    expect(poPriceMarker({ linesDiffering: 0, totalDiffSen: 0, comparableLines: 2, lines: 3 }))
      .toEqual({ label: 'Matches PO', tone: 'matches', diffSen: 0 });
  });
  test('nothing to compare (no PO link, or the PO named no price) is NOT "matches"', () => {
    expect(poPriceMarker({ linesDiffering: 0, totalDiffSen: 0, comparableLines: 0, lines: 2 }))
      .toEqual({ label: 'No PO price', tone: 'none', diffSen: 0 });
  });
});
