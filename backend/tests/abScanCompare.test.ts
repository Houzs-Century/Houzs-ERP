import { describe, expect, test } from 'vitest';
// @ts-expect-error plain .mjs module
import { compareSlip, summarise } from '../scripts/lib/ab-scan-compare.mjs';

const truth = { customerName: 'Tan Ah Kow', phones: ['+60 12-345 6789'], deliveryDate: '2026-10-20', totalRm: 1999, depositRm: null, lines: [{}, {}] };

describe('compareSlip', () => {
  test('scores matches, ignores fields the truth leaves empty', () => {
    const read = { customerName: ' tan  ah kow ', phones: ['0123456789'], deliveryDate: '2026-10-20T00:00', totalRm: 1999.2, depositRm: 500, lines: [{}, {}] };
    expect(compareSlip(read, truth)).toEqual({ customerName: true, phone: true, deliveryDate: true, totalRm: true, lineCount: true });
  });
  test('a wrong date, wrong total and missing lines are misses', () => {
    const read = { customerName: 'Tan Ah Kow', phones: [], deliveryDate: '2026-10-21', totalRm: 1500, lines: [{}] };
    expect(compareSlip(read, truth)).toMatchObject({ customerName: true, phone: false, deliveryDate: false, totalRm: false, lineCount: false });
  });
  test('summarise rolls up accuracy and latency', () => {
    const s = summarise([{ cmp: { a: true, b: false }, ms: 1000 }, { cmp: { a: true }, ms: 3000 }]);
    expect(s.overall).toBeCloseTo(2 / 3);
    expect(s.perField).toEqual({ a: '2/2', b: '0/1' });
    expect(s.ms.mean).toBe(2000);
  });
});
