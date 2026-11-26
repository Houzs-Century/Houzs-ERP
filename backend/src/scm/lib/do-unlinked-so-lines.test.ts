
import { describe, it, expect } from 'vitest';
import { findUnlinkedSoItemLines, unlinkedSoLinesResponse } from './do-unlinked-so-lines';

const line = (lineRef: string, itemCode: string, qty: number, soItemId: string | null = null) =>
  ({ lineRef, itemCode, qty, soItemId });

describe('findUnlinkedSoItemLines', () => {
  it('refuses an unlinked line for an item the named SO already orders', () => {
    const out = findUnlinkedSoItemLines('2990-SO-2606-019', [line('0', 'NTYR-PILLOW', 2)], ['NTYR-PILLOW']);
    expect(out).toEqual([
      { lineRef: '0', itemCode: 'NTYR-PILLOW', qty: 2, soDocNo: '2990-SO-2606-019' },
    ]);
  });

  it('allows an unlinked line for an item the SO does not order', () => {
    expect(findUnlinkedSoItemLines('2990-SO-2606-019', [line('0', 'SPARE-LEG', 1)], ['NTYR-PILLOW'])).toEqual([]);
  });

  it('allows a LINKED line — the remaining-qty ceiling already governs it', () => {
    const out = findUnlinkedSoItemLines('2990-SO-2606-019', [line('0', 'NTYR-PILLOW', 2, 'so-item-1')], ['NTYR-PILLOW']);
    expect(out).toEqual([]);
  });

  it('allows everything when the header names no SO', () => {
    for (const doc of [null, undefined, '', '   ']) {
      expect(findUnlinkedSoItemLines(doc, [line('0', 'NTYR-PILLOW', 2)], ['NTYR-PILLOW'])).toEqual([]);
    }
  });

  it('allows everything when the named SO has no matchable lines', () => {
    expect(findUnlinkedSoItemLines('2990-SO-9999-999', [line('0', 'NTYR-PILLOW', 2)], [])).toEqual([]);
  });

  it('matches item codes case- and whitespace-insensitively', () => {
    const out = findUnlinkedSoItemLines('SO-1', [line('0', '  ntyr-pillow ', 2)], ['NTYR-PILLOW']);
    expect(out).toHaveLength(1);
  });

  it('reports every offending line, and only those', () => {
    const out = findUnlinkedSoItemLines(
      '2990-SO-2606-019',
      [
        line('0', 'NTYR-PILLOW', 2),
        line('1', 'BEDFRAME-K', 1, 'so-item-9'),
        line('2', 'SPARE-LEG', 4),
        line('3', 'MATTRESS-Q', 1),
      ],
      ['NTYR-PILLOW', 'BEDFRAME-K', 'MATTRESS-Q'],
    );
    expect(out.map((o) => o.lineRef)).toEqual(['0', '3']);
  });

  it('ignores a line with no item code rather than blocking on it', () => {
    expect(findUnlinkedSoItemLines('SO-1', [line('0', '', 2)], ['NTYR-PILLOW'])).toEqual([]);
  });

  it('the whole DO-2607-005 shape is refused, every line of it', () => {
    const codes = ['NTYR-PILLOW', 'MATTRESS-Q', 'BEDFRAME-K', 'DIVAN-Q', 'HEADBOARD', 'LEG-SET'];
    const out = findUnlinkedSoItemLines('2990-SO-2606-019', codes.map((c, i) => line(String(i), c, 2)), codes);
    expect(out).toHaveLength(6);
  });
});

describe('unlinkedSoLinesResponse', () => {
  it('names the SO and lists the offending items once each', () => {
    const body = unlinkedSoLinesResponse([
      { lineRef: '0', itemCode: 'NTYR-PILLOW', qty: 2, soDocNo: '2990-SO-2606-019' },
      { lineRef: '1', itemCode: 'NTYR-PILLOW', qty: 1, soDocNo: '2990-SO-2606-019' },
      { lineRef: '2', itemCode: 'MATTRESS-Q', qty: 1, soDocNo: '2990-SO-2606-019' },
    ]);
    expect(body.error).toBe('unlinked_so_lines');
    expect(body.soDocNo).toBe('2990-SO-2606-019');
    expect(body.message).toContain('2990-SO-2606-019');
    expect(body.message).toContain('NTYR-PILLOW, MATTRESS-Q');
    expect(body.message).toContain('3 line(s)');
    expect(body.offenders).toHaveLength(3);
  });
});
