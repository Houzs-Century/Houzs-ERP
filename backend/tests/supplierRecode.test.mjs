// The supplier change-code tool (scripts/recode-suppliers.mjs) moves a code
// with its history. What these tests pin is the part that decides WHAT moves:
// a MAP that could land two suppliers on one code, or whose result depends on
// the order of its pairs, is refused before anything is read; and the creditor
// control a supplier's ledger lines move between follows the code prefix the
// way acc/rules.ts apControlRole books new paper (owner 2026-11-20:
// 「就是要分开」, 「A：连旧账一起搬」).
import { describe, expect, it } from 'vitest';
import { parseRecodeMap, creditorControls, controlMove } from '../scripts/lib/supplier-recode.mjs';

describe('reading MAP', () => {
  it('reads OLD:NEW pairs, upper-cased and trimmed', () => {
    expect(parseRecodeMap(' 400-b005:405-B005, 405-N001 : 400-N006 ,')).toEqual({
      ok: true,
      pairs: [{ oldCode: '400-B005', newCode: '405-B005' }, { oldCode: '405-N001', newCode: '400-N006' }],
    });
  });

  it('refuses an empty or malformed MAP', () => {
    expect(parseRecodeMap('').ok).toBe(false);
    expect(parseRecodeMap(undefined).ok).toBe(false);
    expect(parseRecodeMap(' , ').ok).toBe(false);
    expect(parseRecodeMap('400-B005').ok).toBe(false);
    expect(parseRecodeMap('400-B005:405-B005:405-B006').ok).toBe(false);
    expect(parseRecodeMap('BRIGHTSUN:405-B005').ok).toBe(false);
  });

  it('refuses a code mapped to itself', () => {
    expect(parseRecodeMap('400-B005:400-B005')).toMatchObject({ ok: false });
  });

  it('refuses two moves of one supplier and two suppliers onto one code', () => {
    expect(parseRecodeMap('400-B005:405-B005,400-B005:405-B007')).toMatchObject({ ok: false });
    expect(parseRecodeMap('400-B005:405-B005,400-B006:405-B005')).toMatchObject({ ok: false });
  });

  it('refuses a chain or a swap, whose result would depend on the order of the pairs', () => {
    expect(parseRecodeMap('400-B005:405-B005,405-B005:405-B009')).toMatchObject({ ok: false });
    expect(parseRecodeMap('400-N001:405-N001,405-N001:400-N001')).toMatchObject({ ok: false });
  });
});

describe('which creditor control the ledger lines move between', () => {
  const controls = creditorControls([{ role: 'AP', account_code: '400-0000' }]);

  it('takes the company roles over the defaults', () => {
    expect(controls).toEqual({ AP: '400-0000', AP_OTHER: '405-0000' });
    expect(creditorControls([{ role: 'AP_OTHER', account_code: '405-0001' }, { role: 'SALES', account_code: '500-0000' }]))
      .toEqual({ AP: '400-0000', AP_OTHER: '405-0001' });
  });

  it('moves a 400- supplier that becomes 405- from trade to other creditors, and back', () => {
    expect(controlMove('400-D003', '405-D003', controls)).toEqual({ from: '400-0000', to: '405-0000' });
    expect(controlMove('405-N001', '400-N006', controls)).toEqual({ from: '405-0000', to: '400-0000' });
  });

  it('moves nothing when the new code books to the same control', () => {
    expect(controlMove('405-E002', '405-E005', controls)).toBeNull();
    expect(controlMove('400-N001', '400-N009', controls)).toBeNull();
  });
});
