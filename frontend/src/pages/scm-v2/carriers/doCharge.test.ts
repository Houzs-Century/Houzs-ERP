import { describe, expect, test } from 'vitest';
import { bpsToPct, chargeText, pctToBps, readDoCharge } from './doCharge';

describe('a charge on each delivery order, on the card', () => {
  test('a typed % is kept in basis points and shown back as typed', () => {
    expect(pctToBps('7')).toBe(700);
    expect(pctToBps('2.5')).toBe(250);
    expect(pctToBps(' ')).toBe(0);
    expect(pctToBps('9.123')).toBeNull();
    expect(pctToBps('101')).toBeNull();
    expect(pctToBps('nine')).toBeNull();
    expect(bpsToPct(250)).toBe('2.5');
    expect(bpsToPct(0)).toBe('');
  });

  test('reads as the % of goods, the amount per DO, or both', () => {
    expect(chargeText({ bps: 700, amountSen: 0 })).toBe('7% of goods');
    expect(chargeText({ bps: 0, amountSen: 2_500 })).toBe('RM 25.00 per DO');
    expect(chargeText({ bps: 500, amountSen: 2_500 })).toBe('5% of goods + RM 25.00 per DO');
  });

  test('needs a name and something to charge', () => {
    expect(readDoCharge({ name: ' Tax ', pct: '7', rm: '' })).toEqual({ ok: true, rule: { label: 'Tax', bps: 700, amountSen: 0 } });
    expect(readDoCharge({ name: 'Permit', pct: '', rm: '25' })).toEqual({ ok: true, rule: { label: 'Permit', bps: 0, amountSen: 2_500 } });
    expect(readDoCharge({ name: '', pct: '7', rm: '' }).ok).toBe(false);
    expect(readDoCharge({ name: 'Tax', pct: '', rm: '' }).ok).toBe(false);
    expect(readDoCharge({ name: 'Tax', pct: 'x', rm: '' }).ok).toBe(false);
    expect(readDoCharge({ name: 'Tax', pct: '', rm: '-1' }).ok).toBe(false);
  });
});
