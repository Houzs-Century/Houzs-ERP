import { describe, expect, it } from 'vitest';
import { copyLinesWithoutPwp } from './soCopyLines';

const L = (item_code: string, variants: unknown) => ({ item_code, variants });
const codes = (r: { kept: { item_code: string }[] }) => r.kept.map((i) => i.item_code);

describe('copy as new drops PWP reward lines (HC-0149)', () => {
  it('drops a pwpCode line, keeps the rest, counts it', () => {
    const r = copyLinesWithoutPwp([L('SOFA', { fabricCode: 'F1' }), L('PILLOW', { pwp: true, pwpCode: 'PWP-1' }), L('BED', null)], 'CONFIRMED');
    expect(codes(r)).toEqual(['SOFA', 'BED']);
    expect(r.dropped).toBe(1);
  });
  it('drops pwp:true without a code', () => {
    expect(codes(copyLinesWithoutPwp([L('A', { pwp: true })], 'DRAFT'))).toEqual([]);
  });
  it('drops a code without the pwp flag', () => {
    expect(codes(copyLinesWithoutPwp([L('A', { pwpCode: 'X' })], 'DRAFT'))).toEqual([]);
  });
  it('treats a whitespace-only code as no code', () => {
    expect(codes(copyLinesWithoutPwp([L('A', { pwpCode: '   ' })], 'DRAFT'))).toEqual(['A']);
  });
  it('all-reward order leaves nothing kept', () => {
    const r = copyLinesWithoutPwp([L('A', { pwp: true, pwpCode: 'X' }), L('B', { pwp: true, pwpCode: 'Y' })], 'CONFIRMED');
    expect(r.kept).toEqual([]);
    expect(r.dropped).toBe(2);
  });
  it('keeps everything from a CANCELLED source (codes were released)', () => {
    const r = copyLinesWithoutPwp([L('A', { pwp: true, pwpCode: 'X' })], 'CANCELLED');
    expect(codes(r)).toEqual(['A']);
    expect(r.dropped).toBe(0);
  });
});
